#!/usr/bin/env node
'use strict';
/**
 * Batch outreach runner.
 *
 *   node scripts/batch-audit.js targets.txt [outDir]
 *
 * `targets.txt` is one repo per line — a GitHub shorthand, a clone URL, or a
 * local path. Blank lines and `#` comments are ignored.
 *
 *     facebook/react
 *     https://github.com/vercel/next.js
 *     ~/code/my-client-project
 *
 * For each one it shallow-clones (into a temp dir, depth 1, no history),
 * scans, and writes a ready-to-post issue draft — but ONLY for repos that pass
 * the honesty gate in src/audit.js. Repos that are already lean are skipped and
 * listed at the end, because sending those an issue is how you get blocked.
 *
 * It writes files. It never posts anything. Read every draft before you send
 * it: your name is on it, and one wrong number undoes ten right ones.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { analyze } = require('../src/analyze');
const { audit, worthReporting } = require('../src/audit');
const { defaults, inputCost } = require('../src/models');

const CLONE_TIMEOUT_MS = 120000;

function log(...a) { process.stderr.write(a.join(' ') + '\n'); }

function num(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** Turn a target line into { url, slug, local }. */
function parseTarget(line) {
  const t = line.trim();
  if (t.startsWith('~')) {
    return { local: path.join(os.homedir(), t.slice(1)), slug: path.basename(t) };
  }
  if (t.startsWith('/') || t.startsWith('./')) {
    return { local: path.resolve(t), slug: path.basename(path.resolve(t)) };
  }
  if (/^https?:\/\//.test(t) || t.startsWith('git@')) {
    const slug = t.replace(/\.git$/, '').split('/').slice(-2).join('/');
    return { url: t, slug };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) {
    return { url: `https://github.com/${t}.git`, slug: t };
  }
  return null;
}

function shallowClone(url, dest) {
  execFileSync('git', ['clone', '--depth', '1', '--quiet', '--no-tags', url, dest], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: CLONE_TIMEOUT_MS,
  });
}

function main() {
  const [listPath, outDirArg] = process.argv.slice(2);
  if (!listPath) {
    log('usage: node scripts/batch-audit.js <targets.txt> [outDir]');
    process.exit(1);
  }

  const outDir = path.resolve(outDirArg || 'audits');
  fs.mkdirSync(outDir, { recursive: true });

  const targets = fs.readFileSync(listPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(parseTarget)
    .filter(Boolean);

  if (!targets.length) { log('no usable targets'); process.exit(1); }

  const model = defaults()[0];
  const worth = [];
  const skipped = [];
  const failed = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxray-batch-'));

  log(`\nscanning ${targets.length} repositories\n`);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const label = `[${String(i + 1).padStart(2)}/${targets.length}] ${target.slug}`;
    let dir = target.local;
    let cloned = null;

    try {
      if (!dir) {
        dir = cloned = path.join(tmpRoot, target.slug.replace(/[^\w.-]/g, '_'));
        process.stderr.write(`${label} cloning… `);
        shallowClone(target.url, dir);
      } else {
        process.stderr.write(`${label} `);
        if (!fs.existsSync(dir)) throw new Error('path does not exist');
      }

      const report = analyze(dir);
      const verdict = worthReporting(report);
      const t = report.totals;
      const pct = t.tokens ? ((t.wasteTokens / t.tokens) * 100).toFixed(0) : '0';

      if (!verdict.worth) {
        skipped.push({ slug: target.slug, reason: verdict.reason, tokens: t.tokens });
        process.stderr.write(`skip — ${verdict.reason}\n`);
        continue;
      }

      const drafted = audit(report, { format: 'issue', repo: target.slug });
      const safeName = target.slug.replace(/[^\w.-]/g, '_');
      const file = path.join(outDir, `${safeName}.md`);
      fs.writeFileSync(file, drafted.body, 'utf8');

      worth.push({
        slug: target.slug,
        file,
        tokens: t.tokens,
        waste: t.wasteTokens,
        pct: Number(pct),
        strength: verdict.strength,
        top: report.wasteCategories[0] ? report.wasteCategories[0].category : '—',
        cost: inputCost(model, t.wasteTokens),
      });
      process.stderr.write(`${verdict.strength === 'strong' ? 'STRONG' : 'ok'} — ${num(t.tokens)} tok, ${pct}% waste\n`);
    } catch (err) {
      failed.push({ slug: target.slug, error: (err.message || String(err)).split('\n')[0] });
      process.stderr.write(`failed — ${(err.message || err).toString().split('\n')[0]}\n`);
    } finally {
      if (cloned) fs.rmSync(cloned, { recursive: true, force: true });
    }
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  // Rank by how persuasive the finding is, not by repo size.
  worth.sort((a, b) => (b.strength === 'strong') - (a.strength === 'strong') || b.pct - a.pct);

  const index = [];
  index.push('# Audit queue\n');
  index.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${worth.length} worth sending, ${skipped.length} skipped, ${failed.length} failed\n`);
  index.push('Work top to bottom. Read each draft in full before posting — one wrong');
  index.push('number in a public issue costs more than ten correct ones earn.\n');
  index.push('| | Repo | Waste | Share | Biggest item | Draft |');
  index.push('| --- | --- | ---: | ---: | --- | --- |');
  for (const w of worth) {
    index.push(`| ${w.strength === 'strong' ? '🔴' : '🟡'} | ${w.slug} | ${num(w.waste)} | ${w.pct}% | ${w.top} | [draft](${path.basename(w.file)}) |`);
  }
  if (skipped.length) {
    index.push('\n## Skipped — do not contact these\n');
    for (const s of skipped) index.push(`- **${s.slug}** — ${s.reason}`);
  }
  if (failed.length) {
    index.push('\n## Failed\n');
    for (const f of failed) index.push(`- **${f.slug}** — ${f.error}`);
  }
  index.push('');
  fs.writeFileSync(path.join(outDir, 'INDEX.md'), index.join('\n'), 'utf8');

  log(`\n${worth.length} drafts written to ${outDir}/`);
  log(`  ${worth.filter((w) => w.strength === 'strong').length} strong, ${worth.filter((w) => w.strength === 'moderate').length} moderate`);
  log(`  ${skipped.length} skipped as too clean to be worth reporting`);
  if (failed.length) log(`  ${failed.length} failed to scan`);
  log(`\nStart here: ${path.join(outDir, 'INDEX.md')}\n`);
}

main();
