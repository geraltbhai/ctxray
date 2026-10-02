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
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Not a secret in any meaningful sense — see the note above.
const SALT = 'ctxray/1/pro';

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
function generate({ email, tier = 'pro', issued = new Date() }) {
  const payload = JSON.stringify({
    e: email,
    t: tier,
    d: issued.toISOString().slice(0, 10),
  });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `CTXRAY-${b64}-${sign(b64)}`;
}

/**
 * @param {string} key
 * @returns {{valid: boolean, email?: string, tier?: string, issued?: string, error?: string}}
 */
function verify(key) {
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
  return { valid: true, email: payload.e, tier: payload.t, issued: payload.d };
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
    return { valid: false, error: r.error, source: configPath() };
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

module.exports = { generate, verify, status, activate, deactivate, configPath, PRO_FEATURES };
