'use strict';
/** Tiny terminal formatting helpers. No dependencies, honours NO_COLOR. */

const useColor =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

function wrap(open, close) {
  return (s) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
}

const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
};

/** 1234567 -> "1.23M" */
function num(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function bytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function usd(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

/** Horizontal bar built from block characters. */
function bar(fraction, width = 24, color = 'cyan') {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const full = Math.floor(f * width);
  const rem = f * width - full;
  const partials = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const tail = partials[Math.floor(rem * 8)] || '';
  const filled = '█'.repeat(full) + tail;
  const empty = '·'.repeat(Math.max(0, width - filled.length));
  return c[color](filled) + c.gray(empty);
}

/**
 * A two-tone bar: signal portion then waste portion. Falls back to distinct
 * glyphs when colour is unavailable, so the bar still carries its meaning in a
 * pipe, a CI log, or NO_COLOR.
 */
function splitBar(signal, waste, width = 40) {
  const total = signal + waste || 1;
  const s = Math.round((signal / total) * width);
  const w = width - s;
  if (!useColor) return '█'.repeat(s) + '░'.repeat(w);
  return c.green('█'.repeat(s)) + c.red('█'.repeat(w));
}

function pad(s, n) {
  s = String(s);
  const visible = s.replace(/\u001b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - visible.length));
}

function padStart(s, n) {
  s = String(s);
  const visible = s.replace(/\u001b\[[0-9;]*m/g, '');
  return ' '.repeat(Math.max(0, n - visible.length)) + s;
}

function truncPath(p, max) {
  if (p.length <= max) return p;
  const keep = max - 3;
  return `…${p.slice(p.length - keep)}`;
}

function rule(width = 68, char = '─') {
  return c.gray(char.repeat(width));
}

function heading(text) {
  return `\n${c.bold(text)}\n${rule(Math.max(20, text.length + 4))}`;
}

module.exports = { c, num, bytes, usd, bar, splitBar, pad, padStart, truncPath, rule, heading, useColor };
