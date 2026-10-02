#!/usr/bin/env node
'use strict';
/**
 * Calibration harness for the ctxray token estimator.
 *
 *   npm i gpt-tokenizer
 *   node scripts/calibrate.js <dir> [<dir> ...]
 *
 * Reports per-file and aggregate error of estimateTokens() against the real
 * o200k_base BPE tokenizer, grouped by file extension.
 */
const fs = require('fs');
const path = require('path');
const { estimateTokens } = require('../src/tokenizer');

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
  if (depth > 8 || files.length > 4000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (EXTS.has(path.extname(e.name))) files.push(p);
  }
}

const roots = process.argv.slice(2);
if (!roots.length) { console.error('usage: calibrate.js <dir> [...]'); process.exit(1); }
roots.forEach((r) => walk(r));

const byExt = new Map();
let totalReal = 0;
let totalEst = 0;
let sampled = 0;
const absErrors = [];

for (const f of files) {
  let text;
  try {
    const st = fs.statSync(f);
    if (st.size > 400 * 1024 || st.size < 40) continue;
    text = fs.readFileSync(f, 'utf8');
  } catch (_) { continue; }
  if (text.indexOf("\u0000") !== -1) continue; // binary

  let real;
  try { real = encode(text).length; } catch (_) { continue; }
  const est = estimateTokens(text);
  if (real < 20) continue;

  totalReal += real;
  totalEst += est;
  sampled++;
  absErrors.push(Math.abs(est - real) / real);

  const ext = path.extname(f) || '(none)';
  const g = byExt.get(ext) || { real: 0, est: 0, n: 0 };
  g.real += real; g.est += est; g.n++;
  byExt.set(ext, g);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const rows = [...byExt.entries()]
  .filter(([, g]) => g.n >= 3)
  .sort((a, b) => b[1].real - a[1].real);

console.log(`\nfiles sampled: ${sampled}   reference: o200k_base\n`);
console.log('ext      files      real tokens       est tokens     bias');
console.log('------------------------------------------------------------');
for (const [ext, g] of rows) {
  const bias = (g.est - g.real) / g.real;
  console.log(
    ext.padEnd(8) +
    String(g.n).padStart(5) +
    String(g.real).padStart(17) +
    String(g.est).padStart(17) +
    (bias >= 0 ? '   +' : '   ') + pct(bias).padStart(6)
  );
}
absErrors.sort((a, b) => a - b);
const median = absErrors[Math.floor(absErrors.length / 2)] || 0;
const p90 = absErrors[Math.floor(absErrors.length * 0.9)] || 0;
console.log('------------------------------------------------------------');
console.log(`corpus bias      : ${((totalEst - totalReal) / totalReal >= 0 ? '+' : '')}${pct((totalEst - totalReal) / totalReal)}`);
console.log(`median file error: ${pct(median)}`);
console.log(`p90 file error   : ${pct(p90)}`);
console.log(`suggested K.global multiplier: ${(totalReal / totalEst).toFixed(4)}\n`);
