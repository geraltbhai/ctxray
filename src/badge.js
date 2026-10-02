'use strict';
/**
 * Badge output.
 *
 * A repo that adopts ctxray and puts the badge in its README advertises the
 * tool to every visitor, permanently, without anyone having to post anything.
 * That is why this is free-tier: the badge is the cheapest distribution in the
 * project and gating it would be self-defeating.
 *
 * Two flavours:
 *   - a static shields.io URL with the numbers baked in (works anywhere)
 *   - a shields.io *endpoint* JSON file you commit and refresh from CI, so the
 *     badge updates itself as the repo changes
 */

const { gradeFor } = require('./report-terminal');

function num(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// shields.io colour names, mapped from the same grade the report shows.
const GRADE_COLOR = {
  A: 'brightgreen',
  B: 'green',
  C: 'yellow',
  D: 'orange',
  F: 'red',
};

/**
 * shields.io escaping: `-` becomes `--`, `_` becomes `__`, space becomes `_`.
 * Then percent-encode, because a literal `%` in a waste figure ("94%") would
 * otherwise truncate the badge URL. encodeURIComponent leaves `-` and `_`
 * alone, so it is safe to apply afterwards.
 */
function shieldEscape(s) {
  return encodeURIComponent(
    String(s).replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_')
  );
}

/**
 * @param {object} report
 * @param {object} [opts]
 * @param {'tokens'|'waste'|'grade'} [opts.metric='tokens']
 */
function data(report, opts = {}) {
  const t = report.totals;
  const metric = opts.metric || 'tokens';
  const wastePct = t.tokens ? t.wasteTokens / t.tokens : 0;
  const grade = gradeFor(wastePct);

  if (metric === 'waste') {
    return {
      label: 'context waste',
      message: `${(wastePct * 100).toFixed(0)}%`,
      color: GRADE_COLOR[grade.letter],
    };
  }
  if (metric === 'grade') {
    return {
      label: 'context grade',
      message: grade.letter,
      color: GRADE_COLOR[grade.letter],
    };
  }
  return {
    label: 'agent context',
    message: `${num(t.tokens)} tokens`,
    color: GRADE_COLOR[grade.letter],
  };
}

/** shields.io endpoint schema. Commit this and point shields at its raw URL. */
function endpointJson(report, opts = {}) {
  const d = data(report, opts);
  return JSON.stringify({
    schemaVersion: 1,
    label: d.label,
    message: d.message,
    color: d.color,
    labelColor: '555',
    cacheSeconds: 3600,
  }, null, 2);
}

/** A static badge URL — no hosting required. */
function staticUrl(report, opts = {}) {
  const d = data(report, opts);
  return `https://img.shields.io/badge/${shieldEscape(d.label)}-${shieldEscape(d.message)}-${d.color}`;
}

/**
 * Markdown snippet. When `endpointUrl` is given it produces a self-updating
 * badge; otherwise the numbers are frozen into the URL.
 */
function markdown(report, opts = {}) {
  const link = opts.link || 'https://github.com/geraltbhai/ctxray';
  const src = opts.endpointUrl
    ? `https://img.shields.io/endpoint?url=${encodeURIComponent(opts.endpointUrl)}`
    : staticUrl(report, opts);
  return `[![${data(report, opts).label}](${src})](${link})`;
}

module.exports = { data, endpointJson, staticUrl, markdown, GRADE_COLOR };
