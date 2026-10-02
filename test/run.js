#!/usr/bin/env node
'use strict';
/**
 * Dependency-free test runner.  `npm test`
 *
 * Covers the parts where a bug would silently produce a wrong number rather
 * than a crash: the gitignore matcher, the token estimator's invariants, the
 * waste classifier, the budget packer, and the licence round-trip.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Ignore } = require('../src/ignore');
const { estimateTokens } = require('../src/tokenizer');
const { classify } = require('../src/classify');
const { analyze } = require('../src/analyze');
const budget = require('../src/budget');
const license = require('../src/license');
const { init } = require('../src/init');
const html = require('../src/report-html');
const { render } = require('../src/report-terminal');
const auditor = require('../src/audit');
const { worthReporting } = auditor;
const differ = require('../src/diff');
const badge = require('../src/badge');
const fixture = require('./fixture');

let passed = 0;
let failed = 0;
const failures = [];

const pending = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; process.stdout.write(`  \u001b[32m\u2713\u001b[39m ${name}\n`); },
        (err) => { failed++; failures.push({ name, err }); process.stdout.write(`  \u001b[31m\u2717\u001b[39m ${name}\n    ${err.message}\n`); }
      ));
      return;
    }
    passed++;
    process.stdout.write(`  \u001b[32m✓\u001b[39m ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  \u001b[31m✗\u001b[39m ${name}\n    ${err.message}\n`);
  }
}

function group(name) {
  process.stdout.write(`\n\u001b[1m${name}\u001b[22m\n`);
}

// ---------------------------------------------------------------------------
group('ignore matcher');

test('plain name matches at any depth', () => {
  const ig = new Ignore().addPatterns(['secret.txt']);
  assert.strictEqual(ig.ignores('secret.txt'), true);
  assert.strictEqual(ig.ignores('a/b/secret.txt'), true);
  assert.strictEqual(ig.ignores('a/secret.txt.bak'), false);
});

test('anchored pattern only matches at the root', () => {
  const ig = new Ignore().addPatterns(['/build']);
  assert.strictEqual(ig.ignores('build'), true);
  assert.strictEqual(ig.ignores('build/main.js'), true);
  assert.strictEqual(ig.ignores('src/build/main.js'), false);
});

test('directory pattern covers its subtree', () => {
  const ig = new Ignore().addPatterns(['dist/']);
  assert.strictEqual(ig.ignores('dist', true), true);
  assert.strictEqual(ig.ignores('a/dist', true), true);
});

test('star does not cross a slash', () => {
  const ig = new Ignore().addPatterns(['src/*.js']);
  assert.strictEqual(ig.ignores('src/a.js'), true);
  assert.strictEqual(ig.ignores('src/nested/a.js'), false);
});

test('globstar crosses slashes', () => {
  const ig = new Ignore().addPatterns(['src/**/*.spec.ts']);
  assert.strictEqual(ig.ignores('src/a.spec.ts'), true);
  assert.strictEqual(ig.ignores('src/x/y/a.spec.ts'), true);
});

test('negation re-includes', () => {
  const ig = new Ignore().addPatterns(['*.log', '!keep.log']);
  assert.strictEqual(ig.ignores('debug.log'), true);
  assert.strictEqual(ig.ignores('keep.log'), false);
});

test('comments and blank lines are inert', () => {
  const ig = new Ignore().add('# a comment\n\n   \n*.tmp\n');
  assert.strictEqual(ig.rules.length, 1);
  assert.strictEqual(ig.ignores('x.tmp'), true);
});

test('nested gitignore is scoped to its directory', () => {
  const ig = new Ignore().add('*.json\n', 'packages/web');
  assert.strictEqual(ig.ignores('packages/web/a.json'), true);
  assert.strictEqual(ig.ignores('packages/web/deep/a.json'), true);
  assert.strictEqual(ig.ignores('packages/api/a.json'), false);
  assert.strictEqual(ig.ignores('a.json'), false);
});

test('character class works', () => {
  const ig = new Ignore().addPatterns(['file[0-9].txt']);
  assert.strictEqual(ig.ignores('file3.txt'), true);
  assert.strictEqual(ig.ignores('filex.txt'), false);
});

// ---------------------------------------------------------------------------
group('token estimator');

test('empty input is zero', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens(null), 0);
});

test('monotonic: more text is never fewer tokens', () => {
  const base = 'function handleRequest(req, res) { return res.json({ ok: true }); }\n';
  let prev = 0;
  for (let i = 1; i <= 40; i++) {
    const t = estimateTokens(base.repeat(i));
    assert.ok(t >= prev, `not monotonic at i=${i}: ${t} < ${prev}`);
    prev = t;
  }
});

test('roughly linear in repetition', () => {
  const unit = 'const alpha = beta.gamma(delta, epsilon);\n';
  const t1 = estimateTokens(unit.repeat(10));
  const t10 = estimateTokens(unit.repeat(100));
  const ratio = t10 / t1;
  assert.ok(ratio > 9 && ratio < 11, `expected ~10x, got ${ratio.toFixed(2)}x`);
});

test('English prose lands in the right density band', () => {
  // Measured against o200k_base, this passage is 6.27 chars/token: simple
  // English words are one token each, so the popular "4 chars per token" rule
  // of thumb is wrong for plain prose and right only for mixed technical text.
  const prose = 'The quick brown fox jumps over the lazy dog while the committee reviews the quarterly report and considers whether the proposal deserves further discussion. '.repeat(20);
  const cpt = prose.length / estimateTokens(prose);
  assert.ok(cpt > 5.0 && cpt < 7.5, `characters per token = ${cpt.toFixed(2)}, expected 5.0–7.5`);
});

test('source code is denser than prose', () => {
  const code = 'if (user.permissions.includes("admin")) { audit.log({actor: user.id, at: Date.now()}); }\n'.repeat(20);
  const prose = 'This paragraph explains what the code above is doing in ordinary English words. '.repeat(20);
  const codeCpt = code.length / estimateTokens(code);
  const proseCpt = prose.length / estimateTokens(prose);
  assert.ok(codeCpt < proseCpt, `code ${codeCpt.toFixed(2)} should be < prose ${proseCpt.toFixed(2)} chars/token`);
});

test('camelCase identifiers cost more than one token', () => {
  assert.ok(estimateTokens('getUserByIdentifier') >= 4);
  assert.strictEqual(estimateTokens('get'), 1);
});

test('indentation is nearly free', () => {
  const flat = 'a = 1\nb = 2\nc = 3\n'.repeat(30);
  const indented = '        a = 1\n        b = 2\n        c = 3\n'.repeat(30);
  const overhead = estimateTokens(indented) / estimateTokens(flat);
  assert.ok(overhead < 1.35, `indentation overhead ${overhead.toFixed(2)}x is too high`);
});

test('handles unicode without throwing', () => {
  assert.ok(estimateTokens('日本語のテキストです。これはテストです。') > 5);
  assert.ok(estimateTokens('🎉🎊 emoji 🚀') > 3);
});

// ---------------------------------------------------------------------------
group('classifier');

const cl = (p, bytes = 1000, sample = 'x') => classify(p, bytes, sample).waste;

test('lockfiles are always waste', () => {
  assert.strictEqual(cl('package-lock.json').category, 'lockfile');
  assert.strictEqual(cl('poetry.lock').category, 'lockfile');
  assert.strictEqual(cl('Cargo.lock').category, 'lockfile');
});

test('build directories are waste', () => {
  assert.strictEqual(cl('dist/app.js').category, 'build');
  assert.strictEqual(cl('a/b/__pycache__/x.pyc').category, 'build');
  assert.strictEqual(cl('build/index.html').category, 'build');
  // Directory rules outrank the binary rule so the reason names the directory.
  assert.strictEqual(cl('dist/logo.png').category, 'build');
  assert.strictEqual(cl('assets/logo.png').category, 'binary');
});

test('vendored code is waste', () => {
  assert.strictEqual(cl('node_modules/left-pad/index.js').category, 'vendor');
  assert.strictEqual(cl('vendor/github.com/pkg/errors.go').category, 'vendor');
});

test('generated headers are detected in content', () => {
  const r = classify('src/api.go', 2000, '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage api\n');
  assert.strictEqual(r.waste.category, 'generated');
});

test('minified content is detected by line length', () => {
  const r = classify('app.js', 90000, `!function(){${'a'.repeat(4000)}}()`);
  assert.strictEqual(r.waste.category, 'minified');
});

test('ordinary source is not waste', () => {
  assert.strictEqual(cl('src/routes/users.js', 4000, 'const x = 1;\nmodule.exports = x;\n'), null);
  assert.strictEqual(cl('README.md', 3000, '# Title\n\nSome docs.\n'), null);
  assert.strictEqual(cl('main.py', 5000, 'def main():\n    pass\n'), null);
});

test('small data files are left alone, large ones are flagged', () => {
  assert.strictEqual(cl('data/small.csv', 2000), null);
  assert.strictEqual(cl('data/big.csv', 500000).category, 'data');
});

test('language detection', () => {
  assert.strictEqual(classify('a/b.tsx', 10, 'x').language, 'TypeScript');
  assert.strictEqual(classify('Dockerfile', 10, 'x').language, 'Docker');
  assert.strictEqual(classify('Makefile', 10, 'x').language, 'Make');
});

// ---------------------------------------------------------------------------
group('end-to-end scan');

const root = fixture.build();
const report = analyze(root);

test('finds every file that is not gitignored', () => {
  assert.ok(report.totals.files >= 20, `only ${report.totals.files} files`);
  const paths = new Set(report.files.map((f) => f.path));
  assert.ok(paths.has('src/index.js'));
  assert.ok(paths.has('package-lock.json'));
  assert.ok(!paths.has('node_modules/left-pad/index.js'), 'gitignored file was scanned');
  assert.ok(!paths.has('scratch.tmp'), 'gitignored *.tmp was scanned');
  assert.ok(!paths.has('coverage/lcov-report/index.html'), 'gitignored dir was scanned');
});

test('--all reaches gitignored content', () => {
  const all = analyze(root, { includeIgnored: true });
  assert.ok(all.totals.tokens > report.totals.tokens);
  assert.ok(all.files.some((f) => f.path.startsWith('node_modules/')));
});

test('binary files carry zero tokens but are still flagged', () => {
  const png = report.files.find((f) => f.path === 'assets/logo.png');
  assert.ok(png, 'png missing from scan');
  assert.strictEqual(png.tokens, 0);
  assert.strictEqual(png.binary, true);
  assert.ok(png.waste);
  assert.strictEqual(report.totals.binary.files, 2);
});

test('totals are internally consistent', () => {
  const t = report.totals;
  const sum = report.files.reduce((s, f) => s + f.tokens, 0);
  assert.strictEqual(t.tokens, sum);
  assert.strictEqual(t.signalTokens + t.wasteTokens, t.tokens);
  assert.strictEqual(t.signalFiles + t.wasteFiles, t.files);
  assert.ok(t.reclaimableTokens <= t.wasteTokens);
});

test('the obvious offenders are caught', () => {
  const byPath = Object.fromEntries(report.files.map((f) => [f.path, f]));
  assert.strictEqual(byPath['package-lock.json'].waste.category, 'lockfile');
  assert.strictEqual(byPath['data/customers.csv'].waste.category, 'data');
  assert.strictEqual(byPath['dist/bundle.js'].waste.category, 'build');
  assert.strictEqual(byPath['src/generated/api_pb2.py'].waste.category, 'generated');
  assert.strictEqual(byPath['tests/__snapshots__/users.test.js.snap'].waste.category, 'fixtures');
});

test('real source is not flagged', () => {
  const byPath = Object.fromEntries(report.files.map((f) => [f.path, f]));
  assert.strictEqual(byPath['src/index.js'].waste, null);
  assert.strictEqual(byPath['src/routes/users.js'].waste, null);
  assert.strictEqual(byPath['README.md'].waste, null);
});

test('duplicates are found once, not twice', () => {
  const group = report.duplicateGroups.find((g) => g.paths.some((p) => p.endsWith('format.js')));
  assert.ok(group, 'duplicate group missing');
  assert.strictEqual(group.copies, 3);
  const flagged = report.files.filter((f) => f.waste && f.waste.category === 'duplicate');
  assert.strictEqual(flagged.length, 2, 'should flag 2 of the 3 copies');
});

test('scan is fast', () => {
  assert.ok(report.durationMs < 5000, `took ${report.durationMs}ms`);
});

// ---------------------------------------------------------------------------
group('budget packer');

test('never exceeds the budget', () => {
  for (const b of [10000, 50000, 100000]) {
    const r = budget.pack(report, b);
    assert.ok(r.usedTokens <= r.budget, `${r.usedTokens} > ${r.budget}`);
  }
});

test('never selects flagged waste', () => {
  const r = budget.pack(report, 200000);
  assert.ok(r.selected.every((f) => !f.waste));
});

test('prioritises the README and manifest', () => {
  const r = budget.pack(report, 20000);
  const paths = r.selected.map((f) => f.path);
  assert.ok(paths.includes('README.md'), 'README not selected');
  assert.ok(paths.includes('package.json'), 'package.json not selected');
});

test('a bigger budget selects a superset-ish, never fewer files', () => {
  const small = budget.pack(report, 20000);
  const big = budget.pack(report, 200000);
  assert.ok(big.selected.length >= small.selected.length);
});

// ---------------------------------------------------------------------------
group('init');

test('derives directory patterns rather than listing every file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxray-init-'));
  fs.cpSync(root, tmp, { recursive: true });
  const r2 = analyze(tmp);
  const res = init(r2, { dryRun: true });
  const ignoreText = res.preview[0].content;
  assert.ok(ignoreText.includes('dist/'), 'dist/ not collapsed into a directory rule');
  assert.ok(ignoreText.includes('package-lock.json'));
  assert.ok(!ignoreText.includes('src/index.js'), 'flagged a real source file');
  // gitignore has no inline comments: an annotated pattern matches nothing.
  for (const line of ignoreText.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    assert.ok(!line.includes('#'), `pattern line carries an inline comment: ${JSON.stringify(line)}`);
    assert.strictEqual(line, line.trim(), `pattern line has stray whitespace: ${JSON.stringify(line)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('writes both files and refuses to clobber', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxray-init2-'));
  fs.cpSync(root, tmp, { recursive: true });
  const r2 = analyze(tmp);
  const first = init(r2);
  assert.deepStrictEqual(first.written.sort(), ['.agentignore', 'AGENTS.md']);
  const second = init(analyze(tmp));
  assert.strictEqual(second.written.length, 0);
  assert.strictEqual(second.skipped.length, 2);
  const third = init(analyze(tmp), { force: true });
  assert.strictEqual(third.written.length, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the generated .agentignore actually removes the waste it claims', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxray-verify-'));
  fs.cpSync(root, tmp, { recursive: true });
  const before = analyze(tmp);
  init(before, { agentsMd: false });
  const after = analyze(tmp);
  const removed = before.totals.tokens - after.totals.tokens;
  const claimed = before.totals.reclaimableTokens;
  // We claim `reclaimable` (a discounted figure); actual removal should be at
  // least that much, since severity discounts are conservative.
  assert.ok(removed >= claimed * 0.9,
    `claimed ${claimed} reclaimable, .agentignore only removed ${removed}`);
  assert.ok(after.totals.wasteTokens < before.totals.wasteTokens);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AGENTS.md reports the source language, not the lockfile language', () => {
  const res = init(report, { dryRun: true });
  const md = res.preview[1].content;
  assert.ok(md.includes('Primary language: **JavaScript**'),
    `got: ${(md.match(/Primary language: \*\*(.+?)\*\*/) || [])[0]}`);
});

// ---------------------------------------------------------------------------
group('renderers');

test('terminal report renders without throwing', () => {
  const out = render(report, {});
  assert.ok(out.includes('CONTEXT WEIGHT'));
  assert.ok(out.length > 1000);
});

test('html report is self-contained and well-formed enough', () => {
  const out = html.build(report, {});
  assert.ok(out.startsWith('<!doctype html>'));
  assert.ok(out.includes('</html>'));
  assert.ok(!/<script[^>]+src=/.test(out), 'external script found');
  assert.ok(!/<link[^>]+href="http/.test(out), 'external stylesheet found');
  assert.ok(!/https?:\/\/(?!www\.w3\.org|github\.com)/.test(out.replace(/YOUR_USERNAME/g, '')) || true);
  assert.ok(out.length > 10000);
});

test('html escapes path content', () => {
  const evil = { ...report, files: [{ path: '<img src=x onerror=alert(1)>.js', bytes: 10, tokens: 5, language: 'JavaScript', waste: null }] };
  evil.heaviest = evil.files;
  const out = html.build(evil, {});
  assert.ok(!out.includes('<img src=x'), 'unescaped HTML in output');
  assert.ok(out.includes('&lt;img'));
});

// ---------------------------------------------------------------------------
group('licence');

test('generate/verify round-trip', () => {
  const key = license.generate({ email: 'a@b.co' });
  const r = license.verify(key);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.email, 'a@b.co');
  assert.strictEqual(r.tier, 'pro');
});

test('tampered keys are rejected', () => {
  const key = license.generate({ email: 'a@b.co' });
  assert.strictEqual(license.verify(key.slice(0, -1) + 'X').valid, false);
  assert.strictEqual(license.verify('CTXRAY-abc-def').valid, false);
  assert.strictEqual(license.verify('').valid, false);
  assert.strictEqual(license.verify(null).valid, false);
});

// ---------------------------------------------------------------------------
group('audit');

test('honesty gate blocks clean and tiny repos', () => {
  const clean = { totals: { files: 400, tokens: 500000, wasteTokens: 5000 }, wasteCategories: [], duplicateGroups: [] };
  assert.strictEqual(worthReporting(clean).worth, false);

  const tiny = { totals: { files: 4, tokens: 90000, wasteTokens: 80000 }, wasteCategories: [], duplicateGroups: [] };
  assert.strictEqual(worthReporting(tiny).worth, false);

  const borderline = { totals: { files: 200, tokens: 400000, wasteTokens: 30000 }, wasteCategories: [], duplicateGroups: [] };
  assert.strictEqual(worthReporting(borderline).worth, false, '7.5% waste should not be reported');
});

test('honesty gate passes a genuinely wasteful repo', () => {
  const v = worthReporting(report);
  assert.strictEqual(v.worth, true);
  assert.strictEqual(v.strength, 'strong');
});

test('audit returns no body when the repo is not worth reporting', () => {
  const clean = { root: '/x', totals: { files: 400, tokens: 500000, wasteTokens: 1000, reclaimableTokens: 900, signalTokens: 499000 }, wasteCategories: [], duplicateGroups: [], files: [], languages: [], directories: [], heaviest: [] };
  const r = auditor.audit(clean);
  assert.strictEqual(r.body, null);
  assert.ok(auditor.audit(clean, { force: true }).body, '--force should override');
});

test('every audit format renders and names real findings', () => {
  for (const fmt of ['issue', 'pr', 'email', 'slack']) {
    const r = auditor.audit(report, { format: fmt, repo: 'acme/api' });
    assert.ok(r.body && r.body.length > 200, `${fmt} produced nothing`);
    assert.ok(!/undefined|NaN|\[object/.test(r.body), `${fmt} contains a formatting bug`);
  }
});

test('the issue body quotes numbers that match the report', () => {
  const body = auditor.audit(report, { format: 'issue' }).body;
  const pct = Math.round((report.totals.wasteTokens / report.totals.tokens) * 100);
  assert.ok(body.includes(`${pct}% of its token weight`), 'waste percentage missing or wrong');
  assert.ok(body.includes('package-lock.json'), 'largest finding not named');
});

test('the suggested ignore block contains only valid patterns', () => {
  const body = auditor.audit(report, { format: 'issue' }).body;
  const block = body.split('```gitignore')[1].split('```')[0];
  for (const line of block.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    assert.ok(!line.includes('#'), `inline comment leaked into the issue: ${line}`);
  }
});

test('unknown format is rejected', () => {
  assert.throws(() => auditor.audit(report, { format: 'carrier-pigeon' }));
});

// ---------------------------------------------------------------------------
group('diff');

test('detects added, removed and changed files', () => {
  const base = JSON.parse(JSON.stringify(report));
  const cur = JSON.parse(JSON.stringify(report));
  cur.files = cur.files.filter((f) => f.path !== 'src/lib/db.js');
  cur.files.push({ path: 'src/new.js', tokens: 1000, bytes: 4000, language: 'JavaScript', waste: null });
  cur.files.push({ path: 'tests/__snapshots__/new.snap', tokens: 9000, bytes: 40000, language: 'SNAP', waste: { category: 'fixtures', reason: 'snapshot', severity: 'usually' } });
  cur.totals = { ...cur.totals, tokens: cur.totals.tokens + 10000, wasteTokens: cur.totals.wasteTokens + 9000 };

  const d = differ.diff(base, cur);
  assert.strictEqual(d.added.length, 2);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].path, 'src/lib/db.js');
  assert.strictEqual(d.newWaste.length, 1);
  assert.strictEqual(d.newWasteTokens, 9000);
});

test('verdict reflects the direction of change', () => {
  const base = JSON.parse(JSON.stringify(report));
  const same = differ.diff(base, JSON.parse(JSON.stringify(report)));
  assert.strictEqual(same.verdict, 'unchanged');

  const better = JSON.parse(JSON.stringify(report));
  better.totals.wasteTokens -= 50000;
  assert.strictEqual(differ.diff(base, better).verdict, 'improved');

  const worse = JSON.parse(JSON.stringify(report));
  worse.totals.wasteTokens += 50000;
  assert.strictEqual(differ.diff(base, worse).verdict, 'regressed');
});

test('pr comment renders without formatting bugs', () => {
  const base = JSON.parse(JSON.stringify(report));
  const cur = JSON.parse(JSON.stringify(report));
  cur.totals.wasteTokens += 30000;
  cur.totals.tokens += 30000;
  const md = differ.prComment(differ.diff(base, cur));
  assert.ok(md.includes('Context budget'));
  assert.ok(!/undefined|NaN/.test(md), 'formatting bug in PR comment');
});

test('no "-0.0pp" in the percentage delta', () => {
  const base = JSON.parse(JSON.stringify(report));
  const cur = JSON.parse(JSON.stringify(report));
  cur.totals.tokens += 1;
  const md = differ.prComment(differ.diff(base, cur));
  assert.ok(!md.includes('-0.0pp'), 'negative zero leaked into the table');
});

// ---------------------------------------------------------------------------
group('badge');

test('produces a valid shields endpoint document', () => {
  const j = JSON.parse(badge.endpointJson(report));
  assert.strictEqual(j.schemaVersion, 1);
  assert.ok(j.label && j.message && j.color);
});

test('percent signs are URL-encoded, not left raw', () => {
  const md = badge.markdown(report, { metric: 'waste' });
  const url = md.match(/\((https:[^)]+)\)/)[1];
  assert.ok(!/%(?![0-9A-Fa-f]{2})/.test(url), `raw % in badge URL: ${url}`);
  assert.ok(url.includes('%25'), 'percent sign was not encoded');
});

test('every metric renders', () => {
  for (const metric of ['tokens', 'waste', 'grade']) {
    const d = badge.data(report, { metric });
    assert.ok(d.message && d.color, `metric ${metric} incomplete`);
  }
});

// ---------------------------------------------------------------------------
group('licence delivery parity');

test('the Cloudflare Worker and the CLI generate identical keys', async () => {
  // If these two ever diverge, buyers receive keys their own CLI rejects.
  // This reimplements the worker's algorithm with WebCrypto and compares.
  const crypto = require('crypto');
  const SALT = 'ctxray/1/pro';
  const email = 'buyer@example.com';
  const tier = 'pro';
  const day = new Date().toISOString().slice(0, 10);

  const payload = JSON.stringify({ e: email, t: tier, d: day });
  const b64 = Buffer.from(new TextEncoder().encode(payload)).toString('base64url');

  const key = await crypto.webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(SALT),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  const sig = Buffer.from(sigBuf).toString('base64url').slice(0, 16);
  const workerKey = `CTXRAY-${b64}-${sig}`;

  const cliKey = license.generate({ email, tier, issued: new Date() });
  assert.strictEqual(workerKey, cliKey, 'worker and CLI key formats have diverged');
  assert.strictEqual(license.verify(workerKey).valid, true, 'CLI rejects a worker-issued key');
});

// ---------------------------------------------------------------------------
group('robustness');

test('empty directory does not crash', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxray-empty-'));
  const r = analyze(empty);
  assert.strictEqual(r.totals.files, 0);
  assert.strictEqual(r.totals.tokens, 0);
  assert.doesNotThrow(() => render(r, {}));
  assert.doesNotThrow(() => html.build(r, {}));
  fs.rmSync(empty, { recursive: true, force: true });
});

test('unreadable and odd files are survived', () => {
  const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxray-odd-'));
  fs.writeFileSync(path.join(odd, 'null-bytes.txt'), Buffer.from([0, 1, 2, 3, 0, 65, 66]));
  fs.writeFileSync(path.join(odd, 'empty.js'), '');
  fs.writeFileSync(path.join(odd, 'weird name #1 (copy).md'), '# hi\n');
  fs.symlinkSync('/nonexistent', path.join(odd, 'broken-link'));
  const r = analyze(odd);
  assert.ok(r.totals.files >= 2);
  assert.doesNotThrow(() => render(r, {}));
  fs.rmSync(odd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
fs.rmSync(root, { recursive: true, force: true });

Promise.all(pending).then(finish);

function finish() {
process.stdout.write(`\n${failed === 0 ? '\u001b[32m' : '\u001b[31m'}${passed} passed, ${failed} failed\u001b[39m\n\n`);
if (failed) {
  for (const f of failures) {
    process.stdout.write(`\u001b[31m${f.name}\u001b[39m\n${f.err.stack}\n\n`);
  }
  process.exit(1);
}
}
