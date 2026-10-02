#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { analyze } = require('../src/analyze');
const { render } = require('../src/report-terminal');
const html = require('../src/report-html');
const { init } = require('../src/init');
const budget = require('../src/budget');
const license = require('../src/license');
const auditor = require('../src/audit');
const differ = require('../src/diff');
const badge = require('../src/badge');
const { MODELS, byId, defaults, inputCost, PRICES_CHECKED } = require('../src/models');
const ui = require('../src/ui');
const { c, num, usd, bytes } = ui;
const pkg = require('../package.json');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set([
  'help', 'version', 'json', 'exact', 'all', 'no-color', 'quiet', 'ci',
  'force', 'dry-run', 'no-agents-md', 'models', 'no-gitignore', 'list-files',
  'badge', 'list', 'copy', 'fail-on-regression',
]);

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val = eq === -1 ? undefined : a.slice(eq + 1);
      if (val === undefined) {
        if (BOOL_FLAGS.has(key)) val = true;
        else { val = argv[i + 1]; i++; }
      }
      if (key === 'exclude' || key === 'model') {
        opts[key] = opts[key] || [];
        opts[key].push(val);
      } else {
        opts[key] = val;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const short = { h: 'help', v: 'version', j: 'json', q: 'quiet', a: 'all', o: 'out' };
      const key = short[a.slice(1)];
      if (key) {
        if (key === 'out') { opts[key] = argv[i + 1]; i++; }
        else opts[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

/** "100k", "1.5m", "200000" -> number */
function parseCount(s) {
  if (s === undefined || s === null) return NaN;
  const m = /^([\d.]+)\s*([kmKM])?$/.exec(String(s).trim().replace(/[,_]/g, ''));
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const suf = (m[2] || '').toLowerCase();
  return Math.round(n * (suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : 1));
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function help() {
  const B = c.bold;
  const G = c.gray;
  const C = c.cyan;
  return `
${B(c.cyan('ctxray'))} ${G('v' + pkg.version)} — see what your repo costs an AI agent.

${B('USAGE')}
  ctxray [path] [options]
  ctxray init [path]              write a tuned .agentignore + AGENTS.md
  ctxray audit [path]             draft a report you can send to a maintainer
  ctxray budget <tokens> [path]   pick the highest-value files that fit a window
  ctxray diff <baseline.json>     what a change did to the context budget
  ctxray activate <key>           unlock Pro features
  ctxray license                  show licence status

${B('SCAN OPTIONS')}
  ${C('-a, --all')}                 include files .gitignore excludes (node_modules, dist…)
  ${C('--no-gitignore')}            ignore .gitignore entirely
  ${C('--exclude <glob>')}          extra exclusion, repeatable
  ${C('--exact')}                   exact BPE counts ${G('(needs: npm i gpt-tokenizer)')}
  ${C('--max-file-size <bytes>')}   skip files bigger than this ${G('(default 16MB)')}

${B('OUTPUT')}
  ${C('-j, --json')}                machine-readable report on stdout
  ${C('--html <file>')}             ${G('PRO')}  self-contained visual report
  ${C('-q, --quiet')}               summary line only
  ${C('--list-files')}              one "tokens\\tpath" per line, sorted heaviest first
  ${C('--badge')}                   README badge markdown ${G('(--badge-json <file> for CI)')}
  ${C('--no-color')}                disable ANSI colour

${B('COST MODEL')}
  ${C('--model <id>')}              price against this model, repeatable
  ${C('--runs-per-day <n>')}        projection volume ${G('(default 20)')}
  ${C('--pricing <file.json>')}     override the price table
  ${C('--models')}                  list model ids and prices

${B('CI')}   ${G('PRO')}
  ${C('--ci')}                      terse output, non-zero exit on threshold breach
  ${C('--max-waste <percent>')}     fail if waste exceeds this share
  ${C('--max-tokens <n>')}          fail if the repo exceeds this token count

${B('INIT OPTIONS')}
  ${C('--force')}                   overwrite existing files
  ${C('--dry-run')}                 print what would be written
  ${C('--no-agents-md')}            only write .agentignore

${B('AUDIT OPTIONS')}
  ${C('--format <kind>')}           issue ${G('(default)')}, pr, email, slack
  ${C('--repo <name>')}             name to use in the write-up
  ${C('--out <file>')}              write instead of printing
  ${C('--force')}                   draft even when the repo is too clean to report

${B('DIFF OPTIONS')}   ${G('PRO')}
  ${C('--format pr')}               markdown for a pull-request comment
  ${C('--fail-on-regression')}      exit non-zero when waste grows

${B('EXAMPLES')}
  ${G('$')} npx ctxray
  ${G('$')} npx ctxray ~/code/api --model sonnet-5 --runs-per-day 60
  ${G('$')} npx ctxray --all              ${G('# how bad would it be without .gitignore?')}
  ${G('$')} npx ctxray init --dry-run
  ${G('$')} npx ctxray audit --format issue
  ${G('$')} npx ctxray budget 100k > context-files.txt
  ${G('$')} npx ctxray --json > base.json && npx ctxray diff base.json --format pr
  ${G('$')} npx ctxray --ci --max-waste 15
`;
}

// ---------------------------------------------------------------------------
// Pro gate
// ---------------------------------------------------------------------------

function requirePro(feature) {
  const st = license.status();
  if (st.valid) return st;
  process.stderr.write(`
  ${c.yellow('⬥')} ${c.bold(feature)} is a ctxray Pro feature.

  Everything that ${c.bold('finds')} problems is free forever. Pro unlocks the outputs
  you share and automate: the HTML report, the context packer, CI thresholds.

  ${c.cyan('One-time licence, all future versions:')}
    ${c.underline('https://eigensys-website.vercel.app/#contact')}

  Already bought?  ${c.cyan('ctxray activate CTXRAY-…')}
  Or set ${c.cyan('CTXRAY_LICENSE')} in your environment / CI secrets.

`);
  process.exit(2);
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function resolveModels(opts) {
  if (opts.pricing) {
    try {
      const custom = JSON.parse(fs.readFileSync(opts.pricing, 'utf8'));
      const list = Array.isArray(custom) ? custom : custom.models;
      if (Array.isArray(list) && list.length) return list;
    } catch (e) {
      fail(`could not read pricing file: ${e.message}`);
    }
  }
  if (opts.model && opts.model.length) {
    const chosen = [];
    for (const id of opts.model) {
      const m = byId(id);
      if (!m) fail(`unknown model "${id}". Run --models to list them.`);
      chosen.push(m);
    }
    return chosen;
  }
  return defaults();
}

function assertDir(root) {
  if (!fs.existsSync(root)) fail(`no such path: ${root}`);
  if (!fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
  return root;
}

function runScan(root, opts) {
  assertDir(root);
  const t0 = Date.now();
  const spinner = startSpinner(opts);
  let report;
  try {
    report = analyze(root, {
      respectGitignore: !opts['no-gitignore'],
      includeIgnored: !!opts.all,
      exact: !!opts.exact,
      exclude: opts.exclude || [],
      maxFileBytes: opts['max-file-size'] ? Number(opts['max-file-size']) : undefined,
      onProgress: spinner.tick,
    });
  } finally {
    spinner.stop();
  }
  if (opts.exact && report.tokenizer.indexOf('exact') === -1) {
    process.stderr.write(c.yellow('  note: --exact requested but gpt-tokenizer is not installed; using the estimator.\n'));
  }
  report.scanMs = Date.now() - t0;
  return report;
}

function startSpinner(opts) {
  if (opts.quiet || opts.json || opts.ci || !process.stderr.isTTY) {
    return { tick() {}, stop() {} };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let count = 0;
  const id = setInterval(() => {
    process.stderr.write(`\r  ${c.cyan(frames[i++ % frames.length])} scanning… ${count ? c.gray(`${count} files`) : ''}   `);
  }, 80);
  return {
    tick(n) { count = n; },
    stop() { clearInterval(id); process.stderr.write('\r' + ' '.repeat(48) + '\r'); },
  };
}

function cmdScan(root, opts) {
  const report = runScan(root, opts);
  const models = resolveModels(opts);
  const runsPerDay = opts['runs-per-day'] ? Number(opts['runs-per-day']) : 20;
  const t = report.totals;
  const wastePct = t.tokens ? t.wasteTokens / t.tokens : 0;

  if (opts.json) {
    // `files` is always included: it is the only machine-readable format, and
    // `ctxray diff` needs the per-file list to compare against a baseline.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }

  if (opts['list-files']) {
    const sorted = [...report.files].sort((a, b) => b.tokens - a.tokens);
    process.stdout.write(sorted.map((f) => `${f.tokens}\t${f.path}`).join('\n') + '\n');
    return 0;
  }

  if (opts.badge || opts['badge-json']) {
    return cmdBadge(report, opts);
  }

  if (opts.html) {
    requirePro('The HTML report');
    const out = String(opts.html);
    fs.writeFileSync(out, html.build(report, { models, runsPerDay }), 'utf8');
    if (!opts.quiet) {
      process.stdout.write(`\n  ${c.green('✓')} wrote ${c.bold(out)} ${c.gray(`(${bytes(fs.statSync(out).size)})`)}\n`);
      process.stdout.write(`    ${c.gray('open it:')} ${c.cyan(`open ${out}`)}\n\n`);
    }
    return 0;
  }

  if (opts.ci) {
    requirePro('CI mode');
    return cmdCi(report, opts, models, wastePct);
  }

  if (opts.quiet) {
    const primary = models[0];
    process.stdout.write(
      `${num(t.tokens)} tokens · ${(wastePct * 100).toFixed(0)}% waste · ` +
      `${usd(inputCost(primary, t.tokens))}/pass on ${primary.label}\n`
    );
    return 0;
  }

  process.stdout.write(render(report, { models, runsPerDay }));
  maybeUpsell(opts);
  return 0;
}

function maybeUpsell(opts) {
  if (opts.quiet || license.status().valid) return;
  process.stdout.write(
    `  ${c.gray('Pro adds the HTML report, the context packer and CI thresholds —')}\n` +
    `  ${c.gray('one-time licence at')} ${c.cyan('https://eigensys-website.vercel.app/#contact')}\n\n`
  );
}

function cmdCi(report, opts, models, wastePct) {
  const t = report.totals;
  const maxWaste = opts['max-waste'] !== undefined ? Number(opts['max-waste']) : null;
  const maxTokens = opts['max-tokens'] !== undefined ? parseCount(opts['max-tokens']) : null;
  const failures = [];

  if (maxWaste !== null && wastePct * 100 > maxWaste) {
    failures.push(`waste ${(wastePct * 100).toFixed(1)}% exceeds --max-waste ${maxWaste}%`);
  }
  if (maxTokens !== null && t.tokens > maxTokens) {
    failures.push(`${t.tokens.toLocaleString()} tokens exceeds --max-tokens ${maxTokens.toLocaleString()}`);
  }

  const primary = models[0];
  process.stdout.write(
    `ctxray: ${t.tokens.toLocaleString()} tokens, ${t.wasteTokens.toLocaleString()} waste ` +
    `(${(wastePct * 100).toFixed(1)}%), ${usd(inputCost(primary, t.tokens))}/pass on ${primary.label}\n`
  );

  // GitHub Actions annotations and job summary.
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const f of failures) process.stdout.write(`::error title=ctxray::${f}\n`);
    for (const cat of report.wasteCategories.slice(0, 5)) {
      process.stdout.write(`::notice title=ctxray waste::${cat.category}: ${cat.tokens.toLocaleString()} tokens across ${cat.files} files\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ciSummaryMarkdown(report, primary, wastePct, failures));
      } catch (_) { /* non-fatal */ }
    }
  }

  if (failures.length) {
    for (const f of failures) process.stderr.write(`ctxray: FAIL — ${f}\n`);
    process.exit(1);
  }
  process.stdout.write('ctxray: OK\n');
  return 0;
}

function ciSummaryMarkdown(report, model, wastePct, failures) {
  const t = report.totals;
  const L = [];
  L.push(`## ctxray — context budget\n`);
  L.push(failures.length ? `**❌ ${failures.length} threshold breach(es)**\n` : `**✅ within budget**\n`);
  for (const f of failures) L.push(`- ${f}\n`);
  L.push(`\n| Metric | Value |\n| --- | ---: |\n`);
  L.push(`| Total tokens | ${t.tokens.toLocaleString()} |\n`);
  L.push(`| Waste | ${t.wasteTokens.toLocaleString()} (${(wastePct * 100).toFixed(1)}%) |\n`);
  L.push(`| Reclaimable | ${t.reclaimableTokens.toLocaleString()} |\n`);
  L.push(`| Cost per pass (${model.label}) | ${usd(inputCost(model, t.tokens))} |\n`);
  if (report.wasteCategories.length) {
    L.push(`\n<details><summary>Top waste categories</summary>\n\n| Category | Tokens | Files |\n| --- | ---: | ---: |\n`);
    for (const cat of report.wasteCategories.slice(0, 8)) {
      L.push(`| ${cat.category} | ${cat.tokens.toLocaleString()} | ${cat.files} |\n`);
    }
    L.push(`\n</details>\n`);
  }
  return L.join('');
}

function cmdInit(root, opts) {
  const report = runScan(root, opts);
  const res = init(report, {
    force: !!opts.force,
    dryRun: !!opts['dry-run'],
    agentsMd: !opts['no-agents-md'],
  });

  if (opts['dry-run']) {
    for (const target of res.preview) {
      process.stdout.write(`\n${c.bold(c.cyan(`──── ${target.name} `))}${c.gray('─'.repeat(Math.max(0, 60 - target.name.length)))}\n\n`);
      process.stdout.write(target.content);
      process.stdout.write('\n');
    }
    return 0;
  }

  process.stdout.write('\n');
  for (const f of res.written) {
    process.stdout.write(`  ${c.green('✓')} wrote ${c.bold(f)}\n`);
  }
  for (const f of res.skipped) {
    process.stdout.write(`  ${c.yellow('·')} ${f} already exists ${c.gray('— rerun with --force to overwrite')}\n`);
  }
  const t = report.totals;
  process.stdout.write(
    `\n  ${c.gray('These exclusions remove')} ${c.bold(c.green(num(t.reclaimableTokens)))} ${c.gray('tokens')} ` +
    `${c.gray(`(${((t.reclaimableTokens / (t.tokens || 1)) * 100).toFixed(0)}% of the repo)`)}\n`
  );
  process.stdout.write(`  ${c.gray('from every full-context pass. Review the file and delete anything you disagree with.')}\n\n`);
  if (res.written.includes('AGENTS.md')) {
    process.stdout.write(`  ${c.gray('AGENTS.md is a scaffold — the')} ${c.bold('[bracketed]')} ${c.gray('parts need your judgement.')}\n\n`);
  }
  return 0;
}

function cmdBudget(root, tokensArg, opts) {
  requirePro('The context packer');
  const budgetTokens = parseCount(tokensArg);
  if (!budgetTokens || budgetTokens < 1000) {
    fail(`budget needs a token count, e.g. "ctxray budget 100k"`);
  }
  const report = runScan(root, opts);
  const result = budget.pack(report, budgetTokens, {
    reserve: opts.reserve !== undefined ? Number(opts.reserve) : undefined,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      budget: result.rawBudget,
      usable: result.budget,
      used: result.usedTokens,
      coverage: result.coverage,
      files: result.selected.map((f) => ({ path: f.path, tokens: f.tokens, value: f.value })),
    }, null, 2) + '\n');
    return 0;
  }
  if (opts.script) {
    fs.writeFileSync(String(opts.script), budget.toConcatScript(result), { mode: 0o755 });
    process.stderr.write(`  ${c.green('✓')} wrote ${opts.script}\n`);
    return 0;
  }
  if (!process.stdout.isTTY || opts.list) {
    process.stdout.write(budget.toList(result) + '\n');
    return 0;
  }

  process.stdout.write(`\n  ${c.bold('CONTEXT PACK')} ${c.gray(`— ${num(result.rawBudget)} token window, ${(result.reserve * 100).toFixed(0)}% reserved for the conversation`)}\n\n`);
  process.stdout.write(`  ${c.bold(c.green(result.selected.length))} files · ${c.bold(num(result.usedTokens))} tokens · ` +
    `${c.bold((result.coverage * 100).toFixed(0) + '%')} of the repo's signal\n\n`);
  for (const f of result.selected.slice(0, 40)) {
    process.stdout.write(`    ${c.gray(String(f.tokens).padStart(7))}  ${f.path}\n`);
  }
  if (result.selected.length > 40) {
    process.stdout.write(`    ${c.gray(`… and ${result.selected.length - 40} more`)}\n`);
  }
  process.stdout.write(`\n  ${c.gray('Pipe it:')} ${c.cyan('ctxray budget 100k > files.txt')}   ` +
    `${c.gray('or')} ${c.cyan('ctxray budget 100k --script pack.sh')}\n\n`);
  return 0;
}

function cmdAudit(root, opts) {
  const report = runScan(root, opts);
  const models = resolveModels(opts);
  const format = opts.format || 'issue';
  if (!auditor.FORMATS[format]) {
    fail(`unknown --format "${format}". Use: issue, pr, email, slack.`);
  }

  const result = auditor.audit(report, {
    format,
    repo: opts.repo,
    model: models[0],
    force: !!opts.force,
    runsPerDay: opts['runs-per-day'] ? Number(opts['runs-per-day']) : undefined,
    name: opts.name,
    url: opts.url,
  });

  if (!result.body) {
    process.stderr.write(
      `\n  ${c.yellow('·')} ${c.bold('Not worth sending.')}\n` +
      `    ${c.gray(result.worth.reason)}\n\n` +
      `    ${c.gray('Sending a maintainer an issue about a repo that is already clean costs')}\n` +
      `    ${c.gray('their attention and your credibility. Use --force to draft it anyway.')}\n\n`
    );
    return 3;
  }

  if (opts.out) {
    fs.writeFileSync(String(opts.out), result.body, 'utf8');
    process.stderr.write(`\n  ${c.green('✓')} wrote ${c.bold(String(opts.out))}\n`);
  } else {
    process.stdout.write(result.body);
  }

  if (process.stderr.isTTY) {
    const strong = result.worth.strength === 'strong';
    process.stderr.write(
      `\n  ${strong ? c.green('●') : c.yellow('●')} ${c.bold(strong ? 'Strong case' : 'Moderate case')} — ${c.gray(result.worth.reason)}\n` +
      `  ${c.gray('Read it before you post it. If any line is wrong, that is your reputation.')}\n\n`
    );
  }
  return 0;
}

function cmdDiff(baselinePath, root, opts) {
  requirePro('The diff');
  if (!baselinePath) fail('usage: ctxray diff <baseline.json> [path]');
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    fail(`could not read baseline: ${e.message}`);
  }
  if (!baseline.files) {
    fail('that baseline has no per-file data. Regenerate it with: ctxray --json > base.json');
  }

  const current = runScan(root, opts);
  const d = differ.diff(baseline, current);
  const models = resolveModels(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(d, null, 2) + '\n');
  } else if (opts.format === 'pr') {
    process.stdout.write(differ.prComment(d, { model: models[0] }));
  } else {
    process.stdout.write(differ.renderTerminal(d, ui, { model: models[0] }));
  }

  if (opts['fail-on-regression'] && (d.verdict === 'regressed' || d.verdict === 'slightly-worse')) {
    process.stderr.write(`\nctxray: FAIL — context waste grew by ${d.totals.wasteDelta.toLocaleString()} tokens\n`);
    process.exit(1);
  }
  return 0;
}

function cmdBadge(report, opts) {
  const metric = opts.metric || 'tokens';
  if (opts['badge-json']) {
    fs.writeFileSync(String(opts['badge-json']), badge.endpointJson(report, { metric }), 'utf8');
    process.stderr.write(`\n  ${c.green('✓')} wrote ${c.bold(String(opts['badge-json']))}\n`);
    process.stderr.write(`    ${c.gray('Commit it, then point shields at its raw URL:')}\n`);
    process.stderr.write(`    ${c.cyan('![ctx](https://img.shields.io/endpoint?url=RAW_URL_TO_THAT_FILE)')}\n\n`);
    return 0;
  }
  process.stdout.write(badge.markdown(report, { metric, endpointUrl: opts['endpoint-url'], link: opts.link }) + '\n');
  return 0;
}

function cmdModels() {
  process.stdout.write(`\n  ${c.bold('MODEL PRICES')} ${c.gray(`(USD per 1M tokens, checked ${PRICES_CHECKED})`)}\n\n`);
  process.stdout.write(`  ${c.gray('id'.padEnd(16) + 'model'.padEnd(22) + 'input'.padStart(8) + 'output'.padStart(9) + 'context'.padStart(11))}\n`);
  for (const m of MODELS) {
    process.stdout.write(
      '  ' + c.cyan(m.id.padEnd(16)) + m.label.padEnd(22) +
      String('$' + m.input.toFixed(2)).padStart(8) +
      String('$' + m.output.toFixed(2)).padStart(9) +
      String(num(m.context)).padStart(11) +
      (m.note ? c.gray(`  ${m.note}`) : '') + '\n'
    );
  }
  process.stdout.write(`\n  ${c.gray('Override everything with --pricing models.json (same shape as src/models.js).')}\n\n`);
  return 0;
}

function cmdLicense() {
  const st = license.status();
  process.stdout.write('\n');
  if (st.valid) {
    process.stdout.write(`  ${c.green('✓')} ctxray ${c.bold('Pro')} — licensed to ${c.bold(st.email)}\n`);
    process.stdout.write(`    ${c.gray(`tier ${st.tier} · issued ${st.issued} · from ${st.source}`)}\n\n`);
  } else {
    process.stdout.write(`  ${c.yellow('·')} ctxray ${c.bold('Free')} ${c.gray(`(${st.error})`)}\n`);
    process.stdout.write(`    ${c.gray('Pro features:')} ${Object.values(license.PRO_FEATURES).join(', ')}\n`);
    process.stdout.write(`    ${c.cyan('https://eigensys-website.vercel.app/#contact')}\n\n`);
  }
  return 0;
}

function cmdActivate(key) {
  if (!key) fail('usage: ctxray activate CTXRAY-…');
  const r = license.activate(key);
  if (!r.valid) {
    process.stderr.write(`\n  ${c.red('✗')} that key did not verify (${r.error}).\n` +
      `    ${c.gray('Copy the whole key including the CTXRAY- prefix.')}\n\n`);
    process.exit(1);
  }
  process.stdout.write(`\n  ${c.green('✓')} ctxray Pro activated for ${c.bold(r.email)}\n    ${c.gray(`saved to ${r.source}`)}\n\n`);
  return 0;
}

function fail(msg) {
  process.stderr.write(`\n  ${c.red('✗')} ${msg}\n\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(argv) {
  const { opts, positional } = parseArgs(argv);
  if (opts['no-color']) process.env.NO_COLOR = '1';
  if (opts.help) { process.stdout.write(help()); return 0; }
  if (opts.version) { process.stdout.write(pkg.version + '\n'); return 0; }
  if (opts.models) return cmdModels();

  const cmd = positional[0];

  if (cmd === 'init') return cmdInit(positional[1] || '.', opts);
  if (cmd === 'audit') return cmdAudit(positional[1] || '.', opts);
  if (cmd === 'diff') return cmdDiff(positional[1], positional[2] || '.', opts);
  if (cmd === 'budget') return cmdBudget(positional[2] || '.', positional[1], opts);
  if (cmd === 'activate') return cmdActivate(positional[1]);
  if (cmd === 'license' || cmd === 'licence') return cmdLicense();
  if (cmd === 'models') return cmdModels();
  if (cmd === 'help') { process.stdout.write(help()); return 0; }

  const root = cmd || '.';
  if (!fs.existsSync(root)) fail(`no such path: ${root}`);
  if (!fs.statSync(root).isDirectory()) fail(`${root} is not a directory`);
  return cmdScan(root, opts);
}

try {
  process.exitCode = main(process.argv.slice(2)) || 0;
} catch (err) {
  if (err && err.code === 'EPIPE') process.exit(0);
  process.stderr.write(`\n  ${c.red('✗ ctxray crashed')}: ${err && err.message}\n`);
  if (process.env.CTXRAY_DEBUG) process.stderr.write((err && err.stack) + '\n');
  else process.stderr.write(`    ${c.gray('Re-run with CTXRAY_DEBUG=1 for a stack trace, and please open an issue.')}\n\n`);
  process.exit(1);
}
