'use strict';
/**
 * Terminal renderer.
 *
 * Design rule: the first twelve lines must answer "how bad is it and what do I
 * do about it". Everything after that is supporting detail the reader can skim
 * or ignore.
 */

const { c, num, bytes, usd, bar, splitBar, pad, padStart, truncPath, rule } = require('./ui');
const { CATEGORY_LABEL } = require('./classify');
const { defaults, inputCost, PRICES_CHECKED } = require('./models');

const W = 72;

function render(report, opts = {}) {
  const out = [];
  const p = (s = '') => out.push(s);
  const t = report.totals;
  const wastePct = t.tokens ? t.wasteTokens / t.tokens : 0;
  const reclaimPct = t.tokens ? t.reclaimableTokens / t.tokens : 0;
  const models = opts.models && opts.models.length ? opts.models : defaults();
  const primary = models[0];
  const runsPerDay = opts.runsPerDay || 20;

  // ---------------------------------------------------------------- header
  p();
  p(`  ${c.bold(c.cyan('ctxray'))} ${c.gray('·')} ${c.bold(shortRoot(report.root))}`);
  p(`  ${c.gray(`${t.files.toLocaleString()} files · ${bytes(t.bytes)} · scanned in ${report.durationMs}ms · ${report.tokenizer}`)}`);
  if (t.binary && t.binary.files) {
    p(`  ${c.gray(`${t.binary.files} binary file${t.binary.files === 1 ? '' : 's'} (${bytes(t.binary.bytes)}) counted as zero tokens — an agent skips them`)}`);
  }
  p();

  // ---------------------------------------------------------------- verdict
  p(`  ${c.bold('CONTEXT WEIGHT')}`);
  p(`  ${c.bold(c.cyan(num(t.tokens).padEnd(8)))} tokens if an agent ingested this whole repo`);
  p(`  ${c.gray('  ' + splitBar(t.signalTokens, t.wasteTokens, 52))}`);
  p(`  ${c.green('█')} ${c.bold(num(t.signalTokens))} signal ${c.gray(`(${pctStr(1 - wastePct)})`)}   ` +
    `${c.red('█')} ${c.bold(num(t.wasteTokens))} waste ${c.gray(`(${pctStr(wastePct)})`)}`);
  p();

  const grade = gradeFor(wastePct);
  p(`  ${c.bold('GRADE')}  ${grade.color(c.bold(` ${grade.letter} `))}  ${grade.label}`);
  p();

  // ---------------------------------------------------------------- money
  p(`  ${c.bold('COST OF ONE FULL-CONTEXT PASS')}   ${c.gray(`(prices checked ${PRICES_CHECKED})`)}`);
  const maxCost = Math.max(...models.map((m) => inputCost(m, t.tokens)));
  for (const m of models) {
    const cost = inputCost(m, t.tokens);
    const waste = inputCost(m, t.wasteTokens);
    const fits = t.tokens <= m.context;
    p(
      '  ' +
      pad(m.label, 20) +
      padStart(c.bold(usd(cost)), 12) +
      '  ' + bar(cost / (maxCost || 1), 16, 'blue') +
      '  ' + c.gray(`${usd(waste)} of it wasted`) +
      (fits ? '' : c.yellow('  ⚠ exceeds context window'))
    );
  }
  p();

  // ---------------------------------------------------------------- burn
  const dailyWaste = inputCost(primary, t.wasteTokens) * runsPerDay;
  if (t.wasteTokens > 0) {
    p(`  ${c.bold('PROJECTED WASTE')}`);
    p(`  At ${c.bold(runsPerDay)} full-context ${primary.label} calls/day, the ${c.red(num(t.wasteTokens))} wasted tokens cost`);
    p(`  ${c.bold(c.red(usd(dailyWaste)))} /day  ${c.gray('·')}  ${c.bold(c.red(usd(dailyWaste * 30)))} /month  ${c.gray('·')}  ${c.bold(c.red(usd(dailyWaste * 365)))} /year`);
    p(`  ${c.gray(`Adjust the call volume with --runs-per-day N.`)}`);
    p();
  }

  // ---------------------------------------------------------------- waste
  if (report.wasteCategories.length) {
    p(`  ${c.bold('WHERE THE WASTE IS')}`);
    const top = report.wasteCategories.slice(0, 10);
    const maxTok = top[0].tokens || 1;
    for (const cat of top) {
      const label = CATEGORY_LABEL[cat.category] || cat.category;
      p(
        '  ' +
        pad(sevDot(cat.severity) + ' ' + label, 30) +
        padStart(c.bold(num(cat.tokens)), 8) +
        c.gray(' tok ') +
        bar(cat.tokens / maxTok, 18, 'red') +
        c.gray(`  ${cat.files} file${cat.files === 1 ? '' : 's'}`)
      );
    }
    p();
    p(`  ${c.gray('● always excludable   ● usually excludable   ● worth reviewing')}`);
    p();

    // Concrete examples from the two biggest categories.
    p(`  ${c.bold('WORST OFFENDERS')}`);
    const shown = [];
    for (const cat of top.slice(0, 4)) {
      for (const ex of cat.examples.slice(0, 2)) shown.push(ex);
    }
    shown.sort((a, b) => b.tokens - a.tokens);
    for (const ex of shown.slice(0, 8)) {
      p(`  ${padStart(c.red(num(ex.tokens)), 8)} ${c.gray('tok')}  ${pad(truncPath(ex.path, 40), 41)} ${c.gray(ex.reason)}`);
    }
    p();
  }

  // ---------------------------------------------------------------- heaviest
  p(`  ${c.bold('HEAVIEST FILES')}`);
  const heavy = report.heaviest.slice(0, 10);
  const maxH = heavy.length ? heavy[0].tokens : 1;
  for (const f of heavy) {
    const mark = f.waste ? c.red('✗') : c.green('✓');
    p(
      `  ${mark} ${padStart(num(f.tokens), 7)} ${c.gray('tok')}  ` +
      bar(f.tokens / maxH, 14, f.waste ? 'red' : 'green') + '  ' +
      truncPath(f.path, 42)
    );
  }
  p();

  // ---------------------------------------------------------------- dirs
  if (report.directories.length > 1) {
    p(`  ${c.bold('BY DIRECTORY')}`);
    const dirs = report.directories.slice(0, 8);
    const maxD = dirs[0].tokens || 1;
    for (const d of dirs) {
      const wp = d.tokens ? d.wasteTokens / d.tokens : 0;
      p(
        '  ' + pad(truncPath(d.dir, 26), 27) +
        padStart(num(d.tokens), 8) + c.gray(' tok  ') +
        bar(d.tokens / maxD, 16, wp > 0.5 ? 'red' : 'cyan') +
        (wp > 0.05 ? c.gray(`  ${pctStr(wp)} waste`) : '')
      );
    }
    p();
  }

  // ---------------------------------------------------------------- langs
  const langs = report.languages.filter((l) => l.tokens > 0).slice(0, 8);
  if (langs.length > 1) {
    p(`  ${c.bold('BY LANGUAGE')}`);
    const maxL = langs[0].tokens || 1;
    for (const l of langs) {
      p(
        '  ' + pad(l.language, 20) +
        padStart(num(l.tokens), 8) + c.gray(' tok  ') +
        bar(l.tokens / maxL, 20, 'magenta') +
        c.gray(`  ${l.files} file${l.files === 1 ? '' : 's'}`)
      );
    }
    p();
  }

  // ---------------------------------------------------------------- dupes
  if (report.duplicateGroups.length) {
    p(`  ${c.bold('DUPLICATE CONTENT')}  ${c.gray(`${num(t.duplicateTokens)} tokens paid for more than once`)}`);
    for (const g of report.duplicateGroups.slice(0, 5)) {
      p(`  ${padStart(c.yellow(num(g.wasted)), 8)} ${c.gray('tok')}  ${g.copies}× ${truncPath(g.paths[0], 44)}`);
    }
    p();
  }

  // ---------------------------------------------------------------- fit
  p(`  ${c.bold('CONTEXT WINDOW FIT')}`);
  for (const m of models.slice(0, 4)) {
    const ratio = t.tokens / m.context;
    const after = t.signalTokens / m.context;
    p(
      '  ' + pad(m.label, 20) +
      pad(fitStr(ratio), 22) +
      c.gray('→ after cleanup ') + fitStr(after)
    );
  }
  p();

  // ---------------------------------------------------------------- action
  p(rule(W));
  p(`  ${c.bold(c.green('WHAT TO DO'))}`);
  const savedTokens = t.reclaimableTokens;
  const savedPct = pctStr(reclaimPct);
  p(`  Excluding the flagged files removes ${c.bold(c.green(num(savedTokens)))} tokens (${c.bold(savedPct)} of the repo),`);
  p(`  saving ${c.bold(c.green(usd(inputCost(primary, savedTokens))))} on every ${primary.label} full-context pass.`);
  p();
  const cmds = [
    ['ctxray init', 'write a tuned .agentignore + AGENTS.md'],
    ['ctxray --html report.html', 'a shareable visual report'],
    ['ctxray budget 100k', 'pick the best files that fit a window'],
    [`ctxray --ci --max-waste ${Math.max(5, Math.round(wastePct * 100) - 10)}`, 'fail a build when waste creeps back'],
  ];
  const wCmd = Math.max(...cmds.map(([x]) => x.length)) + 2;
  for (const [cmd, why] of cmds) p(`    ${pad(c.cyan(cmd), wCmd)}${c.gray(why)}`);
  p(rule(W));
  p();

  return out.join('\n');
}

function fitStr(ratio) {
  const pctText = `${(ratio * 100).toFixed(0)}%`;
  if (ratio <= 0.5) return c.green(`${pctText} of window`);
  if (ratio <= 1) return c.yellow(`${pctText} of window`);
  return c.red(`${(ratio).toFixed(1)}× over window`);
}

function sevDot(sev) {
  if (sev === 'always') return c.red('●');
  if (sev === 'usually') return c.yellow('●');
  return c.blue('●');
}

function pctStr(x) {
  return `${(x * 100).toFixed(0)}%`;
}

function gradeFor(wastePct) {
  if (wastePct < 0.05) return { letter: 'A', color: c.green, label: 'Lean. An agent sees almost only real code.' };
  if (wastePct < 0.15) return { letter: 'B', color: c.green, label: 'Good. Minor trimming available.' };
  if (wastePct < 0.30) return { letter: 'C', color: c.yellow, label: 'Noticeable drag on every agent call.' };
  if (wastePct < 0.50) return { letter: 'D', color: c.yellow, label: 'Heavy. Most of your token spend is not code.' };
  return { letter: 'F', color: c.red, label: 'Severe. The agent is mostly reading noise.' };
}

function shortRoot(root) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && root.startsWith(home)) return `~${root.slice(home.length)}`;
  return root;
}

module.exports = { render, gradeFor };
