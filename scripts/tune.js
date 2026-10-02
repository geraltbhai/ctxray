#!/usr/bin/env node
'use strict';
/**
 * Parameter tuner for the ctxray token estimator.
 *
 *   npm i gpt-tokenizer
 *   node scripts/tune.js <corpusDir> [...]
 *
 * Runs coordinate descent over the estimator's constants to minimise
 *   loss = mean(|est - real| / real)  +  2 * |corpus bias|
 * The corpus bias term matters because a repo-wide total that is 15% high is
 * worse for budgeting than per-file noise that cancels out.
 *
 * Prints a `K` block ready to paste into src/tokenizer.js.
 */
const fs = require('fs');
const path = require('path');
const { estimateTokens, K } = require('../src/tokenizer');

let encode;
try {
  encode = require('gpt-tokenizer').encode;
} catch (e) {
  console.error('Install the reference tokenizer first:  npm i gpt-tokenizer');
  process.exit(1);
}

const EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.json', '.md', '.txt',
  '.css', '.html', '.yml', '.yaml', '.go', '.rs', '.java', '.rb', '.sh', '.sql', '.c', '.h',
]);

const files = [];
function walk(dir, depth = 0) {
  if (depth > 9 || files.length > 6000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (EXTS.has(path.extname(e.name))) files.push(p);
  }
}

const roots = process.argv.slice(2);
if (!roots.length) { console.error('usage: tune.js <dir> [...]'); process.exit(1); }
roots.forEach(walk);

// ---- build corpus cache ---------------------------------------------------
process.stderr.write('encoding corpus with o200k_base ... ');
const corpus = [];
for (const f of files) {
  let text;
  try {
    const st = fs.statSync(f);
    if (st.size > 300 * 1024 || st.size < 60) continue;
    text = fs.readFileSync(f, 'utf8');
  } catch (_) { continue; }
  if (text.indexOf("\u0000") !== -1) continue;
  let real;
  try { real = encode(text).length; } catch (_) { continue; }
  if (real < 30) continue;
  corpus.push({ ext: path.extname(f), text, real });
}
process.stderr.write(`${corpus.length} files\n`);
if (!corpus.length) { console.error('empty corpus'); process.exit(1); }

// ---- loss -----------------------------------------------------------------
function evaluate(k) {
  let sumRel = 0;
  let totReal = 0;
  let totEst = 0;
  for (const c of corpus) {
    const est = estimateTokens(c.text, k);
    sumRel += Math.abs(est - c.real) / c.real;
    totReal += c.real;
    totEst += est;
  }
  const bias = (totEst - totReal) / totReal;
  return { loss: sumRel / corpus.length + 0.8 * Math.abs(bias), mre: sumRel / corpus.length, bias };
}

// ---- search space ---------------------------------------------------------
const SPACE = {
  wordFree: [3, 4, 5, 6, 7, 8, 9, 10],
  wordSlope: [3, 4, 5, 6, 7, 8, 10, 12],
  digitsPerToken: [2, 2.5, 3, 3.5, 4],
  punctRate: [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8],
  spacesPerToken: [4, 6, 8, 10, 12, 14, 16, 20],
  indentFree: [0, 4, 8, 12, 16, 20, 24, 32],
  newlinePair: [1, 1.25, 1.5, 1.75, 2, 2.5, 3],
  nonAsciiRate: [0.4, 0.5, 0.6, 0.7, 0.8],
};

let best = { ...K };
let bestScore = evaluate(best);
console.error(`start   loss=${bestScore.loss.toFixed(4)} mre=${(bestScore.mre * 100).toFixed(1)}% bias=${(bestScore.bias * 100).toFixed(1)}%`);

const keys = Object.keys(SPACE);
for (let pass = 0; pass < 4; pass++) {
  let improved = false;
  for (const key of keys) {
    for (const v of SPACE[key]) {
      if (best[key] === v) continue;
      const cand = { ...best, [key]: v };
      const s = evaluate(cand);
      if (s.loss < bestScore.loss - 1e-6) {
        best = cand;
        bestScore = s;
        improved = true;
      }
    }
  }
  // Final scalar correction on total bias.
  const g = Number((best.global / (1 + bestScore.bias)).toFixed(4));
  const cand = { ...best, global: g };
  const s = evaluate(cand);
  if (s.loss < bestScore.loss - 1e-6) { best = cand; bestScore = s; improved = true; }

  console.error(`pass ${pass}  loss=${bestScore.loss.toFixed(4)} mre=${(bestScore.mre * 100).toFixed(1)}% bias=${(bestScore.bias * 100).toFixed(1)}%`);
  if (!improved) break;
}

console.log('\nconst K = {');
for (const key of Object.keys(K)) console.log(`  ${key}: ${best[key]},`);
console.log('};');
console.log(`\n// mean relative error ${(bestScore.mre * 100).toFixed(1)}%, corpus bias ${(bestScore.bias * 100).toFixed(1)}%, n=${corpus.length}`);
