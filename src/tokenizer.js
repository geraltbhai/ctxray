'use strict';
/**
 * ctxray token estimator
 * ----------------------
 * A zero-dependency approximation of BPE token counts (o200k / cl100k family).
 *
 * Why not just use tiktoken?
 *   `npx ctxray` should start instantly and work offline. Real tokenizers ship
 *   2-4 MB of vocabulary and take ~300ms to load. For *budgeting* you need
 *   accuracy within a few percent, not exactness. If you want exact numbers,
 *   `npm i gpt-tokenizer` and run `ctxray --exact`.
 *
 * How it works:
 *   Text is segmented into whitespace / newline / letter / digit / punctuation /
 *   non-ASCII runs, then each run is priced with a rule that mirrors real BPE
 *   behaviour. The rules that matter most, in order of impact:
 *
 *     1. "\n" + indentation is a SINGLE token. This dominates Python and any
 *        deeply nested code; ignoring it is why naive estimators are ~40% high.
 *     2. A separator immediately before a word merges into it: " user",
 *        "_user", ".append", "/lib" are each one token, not two.
 *     3. Identifiers split on camelCase / snake_case boundaries, and long
 *        subwords split again roughly every `wordSlope` characters.
 *     4. Punctuation runs partially merge ("});", "=>", '",' are single tokens).
 *     5. Digits group in runs of up to three.
 *
 * The constants below are not guesses. They were fitted by coordinate descent
 * against gpt-tokenizer (o200k_base) over a mixed corpus of Python, JavaScript,
 * JSON, Markdown and minified assets. Reproduce with:
 *
 *     npm i gpt-tokenizer && npm run calibrate
 */

// ---------------------------------------------------------------------------
// Fitted parameters. See scripts/tune.js.
// ---------------------------------------------------------------------------
// Fitted 2026-08-22 against gpt-tokenizer o200k_base over 435 files
// (Python, JavaScript, TypeScript, JSON, Markdown, YAML, C, shell, CSS, HTML).
// Result: mean per-file error 6.8%, corpus-wide bias 0.0%.
const K = {
  wordFree: 4,        // characters covered by a subword's first token
  wordSlope: 6,       // additional characters per additional token
  digitsPerToken: 2.5,
  punctRate: 0.45,    // fraction of punctuation characters surviving as tokens
  spacesPerToken: 8,  // extra indentation characters per extra token
  indentFree: 20,     // indent width absorbed into the preceding newline token
  newlinePair: 2,     // newlines collapsed per token
  cjkRate: 1.0,       // tokens per CJK character
  nonAsciiRate: 0.4,  // tokens per other non-ASCII character
  global: 1.0024,     // final bias correction
};

// Separators that merge into a following word as one token.
const MERGES_RIGHT = new Set(['_', '.', '/', '-', '@', '#', '$', '\\', ':', '*', '+', '<', '(']);

const RE_SEG =
  /([ \t]+)|(\n+|\r\n+)|([A-Za-z]+)|([0-9]+)|([\x00-\x09\x0b-\x1f\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+)|([^\x00-\x7f]+)/g;

const SP = 1, NL = 2, WORD = 3, NUM = 4, PUNCT = 5, WIDE = 6;

/** Segment text into typed runs. Returns a flat [type, value, ...] array. */
function segment(text) {
  const out = [];
  let m;
  RE_SEG.lastIndex = 0;
  while ((m = RE_SEG.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(SP, m[1]);
    else if (m[2] !== undefined) out.push(NL, m[2]);
    else if (m[3] !== undefined) out.push(WORD, m[3]);
    else if (m[4] !== undefined) out.push(NUM, m[4]);
    else if (m[5] !== undefined) out.push(PUNCT, m[5]);
    else out.push(WIDE, m[6]);
  }
  return out;
}

/** Split an identifier into BPE-ish subwords on camelCase boundaries. */
function subwordLengths(word) {
  const lens = [];
  let start = 0;
  for (let i = 1; i < word.length; i++) {
    const prev = word[i - 1];
    const cur = word[i];
    const next = word[i + 1];
    const prevLower = prev >= 'a' && prev <= 'z';
    const curUpper = cur >= 'A' && cur <= 'Z';
    const nextLower = next !== undefined && next >= 'a' && next <= 'z';
    const prevUpper = prev >= 'A' && prev <= 'Z';
    // aB  -> a|B      ABc -> AB|c
    if ((prevLower && curUpper) || (prevUpper && curUpper && nextLower)) {
      lens.push(i - start);
      start = i;
    }
  }
  lens.push(word.length - start);
  return lens;
}

function wordCost(len, k) {
  if (len <= k.wordFree) return 1;
  return 1 + Math.floor((len - k.wordFree) / k.wordSlope);
}

function isCJK(cp) {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

/**
 * Estimate the BPE token count of a string.
 * @param {string} text
 * @param {object} [k] parameter overrides (used by the tuner)
 * @returns {number}
 */
function estimateTokens(text, k) {
  if (!text) return 0;
  k = k || K;
  const seg = segment(text);
  let tokens = 0;

  for (let i = 0; i < seg.length; i += 2) {
    const type = seg[i];
    const val = seg[i + 1];
    const prevType = i >= 2 ? seg[i - 2] : 0;
    const nextType = i + 2 < seg.length ? seg[i + 2] : 0;
    const nextIsAtom = nextType === WORD || nextType === NUM;

    switch (type) {
      case SP: {
        const n = val.length;
        // Indentation directly after a newline is absorbed by that newline token.
        if (prevType === NL && n <= k.indentFree) break;
        // A lone space merges into the following word.
        if (n === 1 && nextIsAtom) break;
        tokens += 1 + Math.floor((n - 1) / k.spacesPerToken);
        break;
      }
      case NL:
        tokens += Math.max(1, Math.ceil(val.length / k.newlinePair));
        break;
      case WORD: {
        const lens = subwordLengths(val);
        for (let j = 0; j < lens.length; j++) tokens += wordCost(lens[j], k);
        break;
      }
      case NUM:
        tokens += Math.ceil(val.length / k.digitsPerToken);
        break;
      case PUNCT: {
        let n = val.length;
        // The final separator merges into a following word or number.
        if (nextIsAtom && MERGES_RIGHT.has(val[n - 1])) n -= 1;
        if (n <= 0) break;
        tokens += Math.max(1, Math.round(n * k.punctRate));
        break;
      }
      case WIDE: {
        let cjk = 0;
        let other = 0;
        for (const ch of val) {
          if (isCJK(ch.codePointAt(0))) cjk++;
          else other++;
        }
        tokens += Math.ceil(cjk * k.cjkRate) + Math.ceil(other * k.nonAsciiRate);
        break;
      }
      default:
        break;
    }
  }

  return Math.max(1, Math.round(tokens * k.global));
}

/**
 * Exact mode. Uses gpt-tokenizer when the user has it installed, otherwise null
 * so callers can fall back to the estimator.
 * @returns {((text: string) => number) | null}
 */
let _exact;
function exactTokenizer() {
  if (_exact !== undefined) return _exact;
  try {
    const enc = require('gpt-tokenizer');
    _exact = (text) => enc.encode(text).length;
  } catch (_) {
    _exact = null;
  }
  return _exact;
}

module.exports = { estimateTokens, exactTokenizer, K, segment };
