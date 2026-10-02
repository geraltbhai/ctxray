'use strict';
/**
 * `ctxray audit` — turn a scan into something you can send to a human.
 *
 * This is the growth engine, and it is free on purpose. The most effective way
 * to tell people this tool exists is to hand a maintainer a specific,
 * quantified, *correct* observation about their own repository. That is a
 * contribution. A link to a product is spam. The difference is entirely in
 * whether the message leads with their numbers or with your name.
 *
 * So this module has an unusual responsibility for a report generator: it
 * refuses to write the message when the message would not be worth receiving.
 * See `worthReporting()`. A tool that generates 20 confident issues about
 * repositories that are already clean will get its author blocked, not paid.
 */

const path = require('path');
const { CATEGORY_LABEL } = require('./classify');
const { defaults, inputCost } = require('./models');
const { derivePatterns, buildAgentIgnore } = require('./init');

function num(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function usd(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// The honesty gate
// ---------------------------------------------------------------------------

/**
 * Decide whether this repository is worth writing to someone about.
 *
 * The thresholds are deliberately high. A repo at 8% waste does not need a
 * GitHub issue from a stranger; sending one anyway costs a maintainer's
 * attention and buys you a reputation you do not want.
 *
 * @returns {{worth: boolean, reason: string, strength: 'strong'|'moderate'|null}}
 */
function worthReporting(report) {
  const t = report.totals;
  const wastePct = t.tokens ? t.wasteTokens / t.tokens : 0;

  if (t.files < 15) {
    return { worth: false, reason: 'Too small to be worth anyone\'s attention.', strength: null };
  }
  if (t.wasteTokens < 20000) {
    return {
      worth: false,
      strength: null,
      reason: `Only ${num(t.wasteTokens)} tokens of waste. Below the threshold where a maintainer would thank you for the issue.`,
    };
  }
  if (wastePct < 0.10) {
    return {
      worth: false,
      strength: null,
      reason: `${(wastePct * 100).toFixed(0)}% waste — this repo is already lean. Do not send this one.`,
    };
  }

  // A single dominant finding is far more persuasive than a long tail.
  const top = report.wasteCategories[0];
  const dominant = top && top.tokens > t.tokens * 0.15;

  if (wastePct >= 0.25 || dominant) {
    return {
      worth: true,
      strength: 'strong',
      reason: dominant
        ? `${CATEGORY_LABEL[top.category] || top.category} alone is ${num(top.tokens)} tokens (${((top.tokens / t.tokens) * 100).toFixed(0)}% of the repo).`
        : `${(wastePct * 100).toFixed(0)}% of the repo is content an agent cannot use.`,
    };
  }

  return {
    worth: true,
    strength: 'moderate',
    reason: `${(wastePct * 100).toFixed(0)}% waste — real, but you will need to write it up carefully.`,
  };
}

// ---------------------------------------------------------------------------
// Finding extraction
// ---------------------------------------------------------------------------

/** The three or four things actually worth naming, as human sentences. */
function findings(report, limit = 4) {
  const t = report.totals;
  const out = [];

  for (const cat of report.wasteCategories.slice(0, limit)) {
    const label = CATEGORY_LABEL[cat.category] || cat.category;
    const ex = cat.examples[0];
    const share = ((cat.tokens / (t.tokens || 1)) * 100).toFixed(0);

    let line;
    if (cat.files === 1 && ex) {
      line = `\`${ex.path}\` — **${num(cat.tokens)} tokens** (${share}% of the repo)`;
    } else {
      line = `**${label}** — ${num(cat.tokens)} tokens across ${cat.files} files (${share}%)`;
      if (ex) line += `, largest is \`${ex.path}\` at ${num(ex.tokens)}`;
    }
    out.push({ line, category: cat.category, tokens: cat.tokens });
  }

  if (report.duplicateGroups.length && !out.some((f) => f.category === 'duplicate')) {
    const g = report.duplicateGroups[0];
    out.push({
      line: `**${g.copies} byte-identical copies** of \`${path.posix.basename(g.paths[0])}\` — ${num(g.wasted)} tokens read more than once`,
      category: 'duplicate',
      tokens: g.wasted,
    });
  }

  return out;
}

/** A context-window sentence, which lands harder than the dollar figure. */
function windowLine(report, model) {
  const t = report.totals;
  const ratio = t.tokens / model.context;
  if (ratio > 1) {
    return `The repo is ${ratio.toFixed(1)}× a ${num(model.context)}-token window, so an agent can never hold all of it — and right now ${((t.wasteTokens / t.tokens) * 100).toFixed(0)}% of what it does load is unusable.`;
  }
  return `The repo fits a ${num(model.context)}-token window at ${(ratio * 100).toFixed(0)}% full, but ${((t.wasteTokens / t.tokens) * 100).toFixed(0)}% of that is content the model cannot use — space that could hold actual code.`;
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

function issueBody(report, opts = {}) {
  const t = report.totals;
  const model = opts.model || defaults()[0];
  const repo = opts.repo || path.basename(report.root);
  const f = findings(report);
  const wastePct = ((t.wasteTokens / (t.tokens || 1)) * 100).toFixed(0);

  const L = [];
  L.push(`### Summary`);
  L.push('');
  L.push(`I was measuring what repositories cost AI coding agents to read and ran a scan on \`${repo}\`. About **${wastePct}% of its token weight** is content a model pays for but cannot use. Sharing the numbers in case they're useful — no action needed if this isn't a priority.`);
  L.push('');
  L.push(`### What the scan found`);
  L.push('');
  for (const item of f) L.push(`- ${item.line}`);
  L.push('');
  L.push(`Total: **${num(t.tokens)} tokens**, of which **${num(t.wasteTokens)} are waste** and ~${num(t.reclaimableTokens)} are safely removable.`);
  L.push('');
  L.push(`### Why it matters`);
  L.push('');
  L.push(windowLine(report, model));
  L.push('');
  L.push(`For contributors using Cursor, Claude Code or Copilot, that's ${usd(inputCost(model, t.wasteTokens))} of every full-context pass spent on files that teach the model nothing — and less room in the window for the code they're actually asking about.`);
  L.push('');
  L.push(`### Suggested fix`);
  L.push('');
  L.push(`An \`.agentignore\` (same syntax as \`.gitignore\`, and readable as a \`.cursorignore\`) covers it:`);
  L.push('');
  L.push('```gitignore');
  const patterns = derivePatterns(report);
  const ignoreLines = buildAgentIgnore(report, patterns)
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .slice(0, 18);
  L.push(ignoreLines.join('\n'));
  if (ignoreLines.length >= 18) L.push('# … full list in the report');
  L.push('```');
  L.push('');
  L.push(`Happy to open a PR with this if it'd be welcome — or feel free to ignore it, I know unsolicited issues are a cost of their own.`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(`<sub>Measured with [ctxray](${opts.url || 'https://github.com/geraltbhai/ctxray'}) (MIT, \`npx ctxray\`). Token counts are BPE estimates, ~6% median error, calibrated against \`o200k_base\`.</sub>`);
  L.push('');
  return L.join('\n');
}

function issueTitle(report) {
  const t = report.totals;
  const top = report.wasteCategories[0];
  if (top && top.tokens > t.tokens * 0.2) {
    const label = (CATEGORY_LABEL[top.category] || top.category).toLowerCase();
    return `Repo carries ~${num(top.tokens)} tokens of ${label} that AI coding agents pay to read`;
  }
  return `~${num(t.wasteTokens)} tokens (${((t.wasteTokens / (t.tokens || 1)) * 100).toFixed(0)}%) of this repo is context AI agents can't use`;
}

function prBody(report, opts = {}) {
  const t = report.totals;
  const model = opts.model || defaults()[0];
  const L = [];
  L.push(`Adds an \`.agentignore\` that keeps ${num(t.reclaimableTokens)} tokens of non-source content out of AI coding agents' context windows.`);
  L.push('');
  L.push(`### What this changes`);
  L.push('');
  L.push('Nothing about the build, the tests, or how the code runs. `.agentignore` is only read by AI tooling — it uses `.gitignore` syntax and is ignored by everything else.');
  L.push('');
  L.push(`### Numbers`);
  L.push('');
  L.push('| | Before | After |');
  L.push('| --- | ---: | ---: |');
  L.push(`| Tokens an agent loads | ${t.tokens.toLocaleString()} | ${(t.tokens - t.reclaimableTokens).toLocaleString()} |`);
  L.push(`| Cost per full pass (${model.label}) | ${usd(inputCost(model, t.tokens))} | ${usd(inputCost(model, t.tokens - t.reclaimableTokens))} |`);
  L.push(`| Share of a ${num(model.context)} window | ${((t.tokens / model.context) * 100).toFixed(0)}% | ${(((t.tokens - t.reclaimableTokens) / model.context) * 100).toFixed(0)}% |`);
  L.push('');
  L.push(`### What's excluded and why`);
  L.push('');
  L.push('| Category | Tokens | Reason |');
  L.push('| --- | ---: | --- |');
  for (const cat of report.wasteCategories.slice(0, 6)) {
    const ex = cat.examples[0];
    L.push(`| ${CATEGORY_LABEL[cat.category] || cat.category} | ${num(cat.tokens)} | ${ex ? ex.reason : '—'} |`);
  }
  L.push('');
  L.push('Every line is reviewable — remove anything you want the agent to keep seeing.');
  L.push('');
  L.push(`<sub>Generated with [ctxray](${opts.url || 'https://github.com/geraltbhai/ctxray'}).</sub>`);
  L.push('');
  return L.join('\n');
}

function emailBody(report, opts = {}) {
  const t = report.totals;
  const model = opts.model || defaults()[0];
  const repo = opts.repo || path.basename(report.root);
  const f = findings(report, 3);
  const runsPerDay = opts.runsPerDay || 20;
  const monthly = inputCost(model, t.wasteTokens) * runsPerDay * 30;

  return [
    `Subject: ${repo} — ${num(t.wasteTokens)} tokens your agents pay for and can't use`,
    '',
    `Hi ${opts.name || 'there'},`,
    '',
    `I measured what ${repo} costs an AI coding agent to read. ${((t.wasteTokens / (t.tokens || 1)) * 100).toFixed(0)}% of it is content the model can't use:`,
    '',
    ...f.map((x) => `  • ${x.line.replace(/\*\*/g, '').replace(/`/g, '')}`),
    '',
    `At ${runsPerDay} full-context calls a day on ${model.label}, that's about ${usd(monthly)}/month spent on files that teach the model nothing — and it makes answers worse, because every model degrades as the window fills with noise.`,
    '',
    `The fix is a ~20-line ignore file. I've attached the full report; happy to walk through it if useful.`,
    '',
    opts.signoff || 'Best,',
    '',
  ].join('\n');
}

function slackBody(report, opts = {}) {
  const t = report.totals;
  const model = opts.model || defaults()[0];
  const repo = opts.repo || path.basename(report.root);
  const top = report.wasteCategories[0];
  return [
    `*${repo}* is ${num(t.tokens)} tokens to an AI agent — ${((t.wasteTokens / (t.tokens || 1)) * 100).toFixed(0)}% of it unusable.`,
    top ? `Biggest single item: ${CATEGORY_LABEL[top.category] || top.category}, ${num(top.tokens)} tokens.` : '',
    `That's ${usd(inputCost(model, t.wasteTokens))} wasted on every full-context pass. ~${num(t.reclaimableTokens)} tokens are safely removable with an \`.agentignore\`.`,
    '',
    '`npx ctxray` to reproduce.',
  ].filter(Boolean).join('\n');
}

const FORMATS = {
  issue: (r, o) => `# ${issueTitle(r)}\n\n${issueBody(r, o)}`,
  pr: prBody,
  email: emailBody,
  slack: slackBody,
};

/**
 * @param {object} report
 * @param {object} opts
 * @param {'issue'|'pr'|'email'|'slack'} [opts.format='issue']
 * @param {boolean} [opts.force] emit even when the repo is not worth reporting
 * @returns {{worth: object, title: string, body: string|null}}
 */
function audit(report, opts = {}) {
  const worth = worthReporting(report);
  const format = opts.format || 'issue';
  const fn = FORMATS[format];
  if (!fn) throw new Error(`unknown audit format "${format}"`);

  if (!worth.worth && !opts.force) {
    return { worth, title: issueTitle(report), body: null };
  }
  return { worth, title: issueTitle(report), body: fn(report, opts) };
}

module.exports = { audit, worthReporting, issueTitle, issueBody, prBody, emailBody, slackBody, findings, FORMATS };
