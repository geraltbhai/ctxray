'use strict';
/**
 * `ctxray diff` — what did this change do to the context budget?
 *
 * A one-off audit gets cleaned up once and drifts back within a quarter. The
 * thing teams actually pay for is the ratchet: a PR comment that says "this
 * branch adds 12k tokens of waste" while the change is still cheap to fix.
 *
 * Compares a fresh scan against a baseline `ctxray --json` snapshot. Everything
 * is computed from the two file lists, so the baseline can come from another
 * branch, a nightly job, or a committed file.
 */

const { CATEGORY_LABEL } = require('./classify');
const { defaults, inputCost } = require('./models');

function num(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function signed(n) {
  return n > 0 ? `+${num(n)}` : num(n);
}

function usd(n) {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1) return `${s}$${a.toFixed(2)}`;
  return `${s}$${a.toFixed(3)}`;
}

/** Percentage-point delta, without the "-0.0pp" that rounding produces. */
function pp(delta) {
  const v = delta * 100;
  if (Math.abs(v) < 0.05) return '0.0pp';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}pp`;
}

/**
 * @param {object} baseline a report produced by `analyze` (or its JSON form)
 * @param {object} current
 * @returns {object} a diff report
 */
function diff(baseline, current) {
  const before = new Map((baseline.files || []).map((f) => [f.path, f]));
  const after = new Map((current.files || []).map((f) => [f.path, f]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [p, f] of after) {
    const b = before.get(p);
    if (!b) {
      added.push(f);
    } else if (b.tokens !== f.tokens) {
      changed.push({ path: p, before: b.tokens, after: f.tokens, delta: f.tokens - b.tokens, waste: f.waste });
    }
  }
  for (const [p, f] of before) {
    if (!after.has(p)) removed.push(f);
  }

  added.sort((a, b) => b.tokens - a.tokens);
  removed.sort((a, b) => b.tokens - a.tokens);
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // New waste is the headline: files that are waste now and weren't before.
  const newWaste = added.filter((f) => f.waste);
  const newWasteTokens = newWaste.reduce((s, f) => s + f.tokens, 0);

  const bt = baseline.totals || {};
  const ct = current.totals || {};

  const wastePctBefore = bt.tokens ? bt.wasteTokens / bt.tokens : 0;
  const wastePctAfter = ct.tokens ? ct.wasteTokens / ct.tokens : 0;

  return {
    baselineAt: baseline.generatedAt,
    currentAt: current.generatedAt,
    totals: {
      tokensBefore: bt.tokens || 0,
      tokensAfter: ct.tokens || 0,
      tokensDelta: (ct.tokens || 0) - (bt.tokens || 0),
      wasteBefore: bt.wasteTokens || 0,
      wasteAfter: ct.wasteTokens || 0,
      wasteDelta: (ct.wasteTokens || 0) - (bt.wasteTokens || 0),
      wastePctBefore,
      wastePctAfter,
      filesBefore: bt.files || 0,
      filesAfter: ct.files || 0,
    },
    added,
    removed,
    changed,
    newWaste,
    newWasteTokens,
    verdict: verdictFor((ct.wasteTokens || 0) - (bt.wasteTokens || 0), newWasteTokens),
  };
}

function verdictFor(wasteDelta, newWasteTokens) {
  if (newWasteTokens >= 20000 || wasteDelta >= 20000) return 'regressed';
  if (wasteDelta > 2000) return 'slightly-worse';
  if (wasteDelta < -2000) return 'improved';
  return 'unchanged';
}

const VERDICT_TEXT = {
  regressed: { emoji: '🔴', text: 'This change adds a significant amount of context an agent cannot use.' },
  'slightly-worse': { emoji: '🟡', text: 'Slightly more agent-visible waste than the baseline.' },
  improved: { emoji: '🟢', text: 'This change reduces agent-visible waste. Nice.' },
  unchanged: { emoji: '⚪', text: 'No meaningful change to the context budget.' },
};

/** Markdown suitable for posting as a pull-request comment. */
function prComment(d, opts = {}) {
  const model = opts.model || defaults()[0];
  const t = d.totals;
  const v = VERDICT_TEXT[d.verdict];

  const L = [];
  L.push(`### ${v.emoji} Context budget — ${v.text}`);
  L.push('');
  L.push('| | Base | This branch | Δ |');
  L.push('| --- | ---: | ---: | ---: |');
  L.push(`| Tokens | ${t.tokensBefore.toLocaleString()} | ${t.tokensAfter.toLocaleString()} | ${signed(t.tokensDelta)} |`);
  L.push(`| Waste | ${t.wasteBefore.toLocaleString()} | ${t.wasteAfter.toLocaleString()} | ${signed(t.wasteDelta)} |`);
  L.push(`| Waste share | ${(t.wastePctBefore * 100).toFixed(1)}% | ${(t.wastePctAfter * 100).toFixed(1)}% | ${pp(t.wastePctAfter - t.wastePctBefore)} |`);
  L.push(`| Cost / full pass | ${usd(inputCost(model, t.tokensBefore))} | ${usd(inputCost(model, t.tokensAfter))} | ${usd(inputCost(model, t.tokensDelta))} |`);
  L.push('');

  if (d.newWaste.length) {
    L.push(`<details open><summary><b>${d.newWaste.length} new file${d.newWaste.length === 1 ? '' : 's'} flagged as waste (${num(d.newWasteTokens)} tokens)</b></summary>`);
    L.push('');
    L.push('| File | Tokens | Why |');
    L.push('| --- | ---: | --- |');
    for (const f of d.newWaste.slice(0, 15)) {
      L.push(`| \`${f.path}\` | ${f.tokens.toLocaleString()} | ${f.waste.reason} |`);
    }
    if (d.newWaste.length > 15) L.push(`| … ${d.newWaste.length - 15} more | | |`);
    L.push('');
    L.push('</details>');
    L.push('');
  }

  const bigAdds = d.added.filter((f) => !f.waste && f.tokens > 1500).slice(0, 8);
  if (bigAdds.length) {
    L.push(`<details><summary>${bigAdds.length} substantial new source file${bigAdds.length === 1 ? '' : 's'}</summary>`);
    L.push('');
    for (const f of bigAdds) L.push(`- \`${f.path}\` — ${f.tokens.toLocaleString()} tokens`);
    L.push('');
    L.push('</details>');
    L.push('');
  }

  if (d.removed.length) {
    const removedTokens = d.removed.reduce((s, f) => s + f.tokens, 0);
    L.push(`<details><summary>${d.removed.length} file${d.removed.length === 1 ? '' : 's'} removed (−${num(removedTokens)} tokens)</summary>`);
    L.push('');
    for (const f of d.removed.slice(0, 10)) L.push(`- \`${f.path}\` — ${f.tokens.toLocaleString()} tokens`);
    L.push('');
    L.push('</details>');
    L.push('');
  }

  L.push(`<sub>ctxray · ${model.label} pricing · baseline from ${d.baselineAt ? new Date(d.baselineAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown'}</sub>`);
  L.push('');
  return L.join('\n');
}

/** Compact terminal rendering. */
function renderTerminal(d, ui, opts = {}) {
  const { c, padStart } = ui;
  const model = opts.model || defaults()[0];
  const t = d.totals;
  const v = VERDICT_TEXT[d.verdict];
  const colour = d.verdict === 'improved' ? c.green : d.verdict === 'unchanged' ? c.gray : d.verdict === 'slightly-worse' ? c.yellow : c.red;

  const L = [];
  L.push('');
  L.push(`  ${c.bold('CONTEXT DIFF')}  ${colour(c.bold(v.text))}`);
  L.push('');
  L.push(`  ${c.gray('                       base      branch         Δ')}`);
  L.push(`  ${'tokens'.padEnd(18)}${padStart(num(t.tokensBefore), 10)}${padStart(num(t.tokensAfter), 12)}${padStart(colour(signed(t.tokensDelta)), 10)}`);
  L.push(`  ${'waste'.padEnd(18)}${padStart(num(t.wasteBefore), 10)}${padStart(num(t.wasteAfter), 12)}${padStart(colour(signed(t.wasteDelta)), 10)}`);
  L.push(`  ${'cost / pass'.padEnd(18)}${padStart(usd(inputCost(model, t.tokensBefore)), 10)}${padStart(usd(inputCost(model, t.tokensAfter)), 12)}${padStart(colour(usd(inputCost(model, t.tokensDelta))), 10)}`);
  L.push('');

  if (d.newWaste.length) {
    L.push(`  ${c.bold(c.red(`${d.newWaste.length} new waste file${d.newWaste.length === 1 ? '' : 's'}`))} ${c.gray(`(${num(d.newWasteTokens)} tokens)`)}`);
    for (const f of d.newWaste.slice(0, 8)) {
      L.push(`    ${padStart(c.red(num(f.tokens)), 8)} ${c.gray('tok')}  ${f.path}`);
      L.push(`             ${c.gray(f.waste.reason)}`);
    }
    L.push('');
  }
  if (!d.newWaste.length && d.verdict !== 'regressed') {
    L.push(`  ${c.green('✓')} no new waste introduced`);
    L.push('');
  }
  return L.join('\n');
}

module.exports = { diff, prComment, renderTerminal, VERDICT_TEXT };
