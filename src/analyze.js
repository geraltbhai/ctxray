'use strict';
/**
 * The scanner. Walks a directory, prices every file in tokens, classifies waste,
 * finds duplicates, and returns a single plain-object report that every output
 * format (terminal, JSON, HTML) renders from.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Ignore } = require('./ignore');
const { classify, BINARY_EXT, RECLAIM } = require('./classify');
const { estimateTokens, exactTokenizer } = require('./tokenizer');

// Directories we never descend into, regardless of .gitignore, because they are
// either enormous or meaningless and walking them wastes wall-clock time.
const HARD_SKIP = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.gradle', '.terraform', '.mypy_cache', '.pytest_cache', '.ruff_cache']);

const SAMPLE_BYTES = 8192;

/**
 * @typedef {Object} FileEntry
 * @property {string} path      POSIX path relative to root
 * @property {number} bytes
 * @property {number} tokens
 * @property {string} language
 * @property {{category:string,reason:string,severity:string}|null} waste
 * @property {string} [hash]
 */

/**
 * @param {string} root
 * @param {object} opts
 * @param {boolean} [opts.respectGitignore=true]
 * @param {boolean} [opts.includeIgnored=false] price files git already ignores
 * @param {boolean} [opts.exact=false]          use a real tokenizer if installed
 * @param {number}  [opts.maxFileBytes]         skip files larger than this
 * @param {string[]} [opts.exclude]             extra ignore patterns
 * @param {(n:number)=>void} [opts.onProgress]
 */
function analyze(root, opts = {}) {
  const started = Date.now();
  root = path.resolve(root);
  const respectGitignore = opts.respectGitignore !== false;
  const includeIgnored = !!opts.includeIgnored;
  const maxFileBytes = opts.maxFileBytes || 16 * 1024 * 1024;

  const exact = opts.exact ? exactTokenizer() : null;
  const countTokens = exact || estimateTokens;

  // --- ignore rules --------------------------------------------------------
  const ig = new Ignore();
  if (respectGitignore) {
    const gi = readIfExists(path.join(root, '.gitignore'));
    if (gi) ig.add(gi, '');
    const ci = readIfExists(path.join(root, '.ctxrayignore'));
    if (ci) ig.add(ci, '');
    const ai = readIfExists(path.join(root, '.agentignore'));
    if (ai) ig.add(ai, '');
  }
  if (opts.exclude && opts.exclude.length) ig.addPatterns(opts.exclude);

  /** @type {FileEntry[]} */
  const files = [];
  const skipped = { ignored: 0, tooLarge: 0, unreadable: 0, ignoredBytes: 0 };
  let scanned = 0;

  walk(root, '');

  function walk(abs, rel) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);

      if (e.isSymbolicLink()) continue;

      if (e.isDirectory()) {
        if (HARD_SKIP.has(e.name) && !includeIgnored) {
          skipped.ignored++;
          continue;
        }
        if (!includeIgnored && ig.ignores(childRel, true)) {
          skipped.ignored++;
          continue;
        }
        // A nested .gitignore extends the rules for its subtree.
        if (respectGitignore) {
          const nested = readIfExists(path.join(childAbs, '.gitignore'));
          if (nested) ig.add(nested, childRel);
        }
        walk(childAbs, childRel);
        continue;
      }

      if (!e.isFile()) continue;

      if (!includeIgnored && ig.ignores(childRel, false)) {
        skipped.ignored++;
        try { skipped.ignoredBytes += fs.statSync(childAbs).size; } catch (_) { /* ignore */ }
        continue;
      }

      let st;
      try { st = fs.statSync(childAbs); } catch (_) { skipped.unreadable++; continue; }
      if (st.size > maxFileBytes) { skipped.tooLarge++; continue; }
      if (st.size === 0) continue;

      const ext = path.extname(e.name).toLowerCase();
      const isBinary = BINARY_EXT.has(ext);

      let text = null;
      let sample = null;
      if (!isBinary) {
        try {
          text = fs.readFileSync(childAbs, 'utf8');
        } catch (_) {
          skipped.unreadable++;
          continue;
        }
        if (text.indexOf('\u0000') !== -1) {
          text = null; // actually binary
        } else {
          sample = text.length > SAMPLE_BYTES ? text.slice(0, SAMPLE_BYTES) : text;
        }
      }

      const { language, waste } = classify(childRel, st.size, sample);

      // Binary files are deliberately counted as ZERO tokens.
      //
      // It is tempting to price them as base64 (they would be enormous) but no
      // sane agent runner ever does that — it skips them. Counting them would
      // inflate every headline number in this report, so they are tracked
      // separately in `totals.binary` and still flagged for the ignore file.
      const isBin = text === null;
      const tokens = isBin ? 0 : countTokens(text);

      const entry = {
        path: childRel,
        bytes: st.size,
        tokens,
        binary: isBin,
        language: isBin ? 'Binary' : language,
        waste: isBin ? (waste || { category: 'binary', reason: 'Binary file — an agent cannot read it', severity: 'always' }) : waste,
      };

      if (text !== null && st.size >= 512) {
        entry.hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
      }

      files.push(entry);
      scanned++;
      if (opts.onProgress && scanned % 500 === 0) opts.onProgress(scanned);
    }
  }

  // --- duplicate detection -------------------------------------------------
  const byHash = new Map();
  for (const f of files) {
    if (!f.hash) continue;
    const g = byHash.get(f.hash);
    if (g) g.push(f);
    else byHash.set(f.hash, [f]);
  }
  let duplicateTokens = 0;
  const duplicateGroups = [];
  for (const [, group] of byHash) {
    if (group.length < 2) continue;
    const wasted = group[0].tokens * (group.length - 1);
    duplicateTokens += wasted;
    duplicateGroups.push({
      tokens: group[0].tokens,
      copies: group.length,
      wasted,
      paths: group.map((g) => g.path),
    });
    // Mark every copy after the first as waste, if not already flagged.
    for (let i = 1; i < group.length; i++) {
      if (!group[i].waste) {
        group[i].waste = {
          category: 'duplicate',
          reason: `Byte-identical to ${group[0].path}`,
          severity: 'usually',
        };
      }
    }
  }
  duplicateGroups.sort((a, b) => b.wasted - a.wasted);

  // --- aggregation ---------------------------------------------------------
  const totalTokens = files.reduce((s, f) => s + f.tokens, 0);
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const binaryFiles = files.filter((f) => f.binary);
  const binaryBytes = binaryFiles.reduce((s, f) => s + f.bytes, 0);

  const categories = new Map();
  let wasteTokens = 0;
  let reclaimable = 0;
  for (const f of files) {
    if (!f.waste) continue;
    wasteTokens += f.tokens;
    reclaimable += f.tokens * (RECLAIM[f.waste.severity] || 0.5);
    const c = categories.get(f.waste.category) || { category: f.waste.category, tokens: 0, files: 0, bytes: 0, severity: f.waste.severity, examples: [] };
    c.tokens += f.tokens;
    c.bytes += f.bytes;
    c.files++;
    if (c.examples.length < 5) c.examples.push({ path: f.path, tokens: f.tokens, reason: f.waste.reason });
    categories.set(f.waste.category, c);
  }
  // Binary files carry zero tokens by design, so they would render as an empty
  // bar. They are surfaced through `totals.binary` instead.
  const wasteCategories = [...categories.values()]
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const languages = new Map();
  for (const f of files) {
    const l = languages.get(f.language) || { language: f.language, tokens: 0, files: 0, bytes: 0, wasteTokens: 0 };
    l.tokens += f.tokens;
    l.bytes += f.bytes;
    l.files++;
    if (f.waste) l.wasteTokens += f.tokens;
    languages.set(f.language, l);
  }
  const languageList = [...languages.values()].sort((a, b) => b.tokens - a.tokens);

  // Directory rollup (top level and second level).
  const dirs = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const key = parts.length === 1 ? '.' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
    const d = dirs.get(key) || { dir: key, tokens: 0, files: 0, wasteTokens: 0 };
    d.tokens += f.tokens;
    d.files++;
    if (f.waste) d.wasteTokens += f.tokens;
    dirs.set(key, d);
  }
  const dirList = [...dirs.values()].sort((a, b) => b.tokens - a.tokens);

  const heaviest = [...files].filter((f) => f.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 40);
  const signalFiles = files.filter((f) => !f.waste);
  const signalTokens = signalFiles.reduce((s, f) => s + f.tokens, 0);

  return {
    version: 1,
    root,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    tokenizer: exact ? 'gpt-tokenizer (exact)' : 'ctxray estimator (~6% median error)',
    totals: {
      files: files.length,
      bytes: totalBytes,
      tokens: totalTokens,
      signalTokens,
      signalFiles: signalFiles.length,
      wasteTokens,
      wasteFiles: files.length - signalFiles.length,
      reclaimableTokens: Math.round(reclaimable),
      duplicateTokens,
      binary: { files: binaryFiles.length, bytes: binaryBytes },
    },
    skipped,
    wasteCategories,
    languages: languageList,
    directories: dirList,
    heaviest,
    duplicateGroups: duplicateGroups.slice(0, 20),
    files,
  };
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

module.exports = { analyze };
