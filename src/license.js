'use strict';
/**
 * Licensing for ctxray Pro.
 *
 * A deliberate design note, stated plainly because pretending otherwise would
 * be dishonest: this check runs entirely on your machine and is trivial to
 * bypass. That is fine. It exists to make paying the easy, obvious path for
 * people and companies who find the tool useful — not to fight anyone.
 *
 * Everything in `ctxray` that finds problems is free forever. Pro unlocks the
 * outputs you share with other people and wire into CI:
 *   --html      the visual report
 *   budget      the context packer
 *   --ci        threshold enforcement and exit codes
 *   --diff      comparison against a baseline
 *
 * A key looks like:  CTXRAY-<base64url payload>-<signature>
 * The payload carries the buyer's email, the tier, and an issue date.
 * Subscription keys also carry `x`, the day the paid period ends. A key with no
 * `x` never expires (comp keys, team invoices).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Not a secret in any meaningful sense — see the note above.
const SALT = 'ctxray/1/pro';

/** Where Pro is sold. One place, so the CLI, README and site never disagree. */
const PRO_URL = 'https://geraltbhai.github.io/ctxray/#pricing';

/** Days a subscription key stays valid past its paid period, so a late card retry never breaks CI. */
const GRACE_DAYS = 5;

const PRO_FEATURES = {
  html: '--html visual report',
  budget: 'budget context packer',
  ci: '--ci threshold enforcement',
  diff: '--diff baseline comparison',
  watch: '--watch mode',
};

function configPath() {
  const dir = process.env.CTXRAY_HOME ||
    path.join(os.homedir(), '.config', 'ctxray');
  return path.join(dir, 'license');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', SALT).update(payloadB64).digest('base64url').slice(0, 16);
}

/** Generate a key. Used by the seller, shipped so buyers can verify the format. */
function generate({ email, tier = 'pro', issued = new Date(), expires = null }) {
  const fields = {
    e: email,
    t: tier,
    d: issued.toISOString().slice(0, 10),
  };
  // Only present on subscription keys. Key order is part of the format: the
  // licence worker must serialise the same fields in the same order.
  if (expires) fields.x = new Date(expires).toISOString().slice(0, 10);
  const payload = JSON.stringify(fields);
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `CTXRAY-${b64}-${sign(b64)}`;
}

/**
 * @param {string} key
 * @param {Date} [now] injectable clock, for tests
 * @returns {{valid: boolean, email?: string, tier?: string, issued?: string, expires?: string, expired?: boolean, error?: string}}
 */
function verify(key, now = new Date()) {
  if (typeof key !== 'string') return { valid: false, error: 'no key' };
  const trimmed = key.trim();
  const m = /^CTXRAY-([A-Za-z0-9_-]+)-([A-Za-z0-9_-]{16})$/.exec(trimmed);
  if (!m) return { valid: false, error: 'malformed key' };
  const [, b64, sig] = m;
  if (sign(b64) !== sig) return { valid: false, error: 'signature mismatch' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return { valid: false, error: 'unreadable payload' };
  }
  const out = { email: payload.e, tier: payload.t, issued: payload.d };
  if (payload.x) {
    out.expires = payload.x;
    const end = Date.parse(payload.x + 'T23:59:59Z') + GRACE_DAYS * 86400000;
    if (Number.isNaN(end)) return { valid: false, error: 'unreadable expiry' };
    if (now.getTime() > end) {
      return { ...out, valid: false, expired: true, error: `subscription ended ${payload.x}` };
    }
  }
  return { valid: true, ...out };
}

/** The day a period of `days` starting at `from` ends, as YYYY-MM-DD. */
function periodEnd(days, from = new Date()) {
  return new Date(from.getTime() + days * 86400000).toISOString().slice(0, 10);
}

/** Read the stored key, or the CTXRAY_LICENSE env var, and verify it. */
function status() {
  const envKey = process.env.CTXRAY_LICENSE;
  if (envKey) {
    const r = verify(envKey);
    if (r.valid) return { ...r, source: 'CTXRAY_LICENSE' };
  }
  try {
    const stored = fs.readFileSync(configPath(), 'utf8');
    const r = verify(stored);
    if (r.valid) return { ...r, source: configPath() };
    return { ...r, valid: false, source: configPath() };
  } catch (_) {
    return { valid: false, error: 'not activated' };
  }
}

function activate(key) {
  const r = verify(key);
  if (!r.valid) return r;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key.trim(), { mode: 0o600 });
  return { ...r, source: p };
}

function deactivate() {
  try { fs.unlinkSync(configPath()); return true; } catch (_) { return false; }
}

module.exports = {
  generate, verify, status, activate, deactivate, configPath, periodEnd,
  PRO_FEATURES, PRO_URL, GRACE_DAYS,
};
