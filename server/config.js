/**
 * The proxy's settings (wallet spec section 2), every one with a local
 * default so no env file is needed on this machine. Read once at boot. The
 * list variables are comma separated, in validator and keyholder order;
 * the browser only ever learns the two counts. EDITION (12.1, 13.1) picks
 * the wallet, the moderator or the attestor edition of the same app; RP_ID
 * is the relying-party id of the browser's two passkey ceremonies. The
 * three lock numbers are the validators' (anossoftware's
 * network/testnet.env on the testnet) and reach the browser through
 * /api/config.
 */

function list(name, fallback) {
  return Object.freeze(
    (process.env[name] ?? fallback)
      .split(',')
      .map((url) => url.trim().replace(/\/+$/, ''))
      .filter((url) => url !== ''),
  );
}

function integer(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return Number(value);
}

function url(name, fallback) {
  return (process.env[name] ?? fallback).replace(/\/+$/, '');
}

/** A variable that must be one of `allowed` when set; `fallback` when it is not. Anything else is refused at boot. */
function oneOf(name, allowed, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  return value;
}

/** A variable's trimmed value; `fallback` when it is unset. An empty value is refused at boot. */
function text(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value.trim();
}

const ports = (from, count) => Array.from({ length: count }, (_, i) => `http://localhost:${from + i}`).join(',');

export const config = Object.freeze({
  port: integer('PORT', 4300),
  /** Which app this proxy serves (wallet spec 12.1, 13.1): the wallet, or the same app with the moderator or the attestor section switched on. */
  edition: oneOf('EDITION', ['wallet', 'moderator', 'attestor'], 'wallet'),
  /** The WebAuthn relying-party id the browser registers and asserts under: the masterpod's RP_ID. localhost in development, wallet.anocloud.com on the servers. */
  rpId: text('RP_ID', 'localhost'),
  masterpodUrl: url('MASTERPOD_URL', 'http://localhost:3100'),
  validatorUrls: list('VALIDATOR_URLS', ports(3001, 5)),
  keyholderUrls: list('KEYHOLDER_URLS', ports(3201, 5)),
  signingServerUrl: url('SIGNING_SERVER_URL', 'http://localhost:3300'),
  shareThreshold: integer('SHARE_THRESHOLD', 3),
  defaultValidator: integer('DEFAULT_VALIDATOR', 1),
  /** The time locks on guarded and vault accounts and the offset, in minutes: the validators' numbers (wallet spec 2), answered to the browser by /api/config. The local defaults are this machine's validators'. */
  guardedLockMinutes: integer('GUARDED_LOCK_MINUTES', 1),
  vaultLockMinutes: integer('VAULT_LOCK_MINUTES', 2),
  lockOffsetMinutes: integer('LOCK_OFFSET_MINUTES', 1),
  distDir: process.env.DIST_DIR ?? 'dist/wallet/browser',
  /** How long a backend has to answer, in milliseconds. */
  proxyTimeoutMs: 120_000,
});

if (config.defaultValidator > config.validatorUrls.length) {
  throw new Error(`DEFAULT_VALIDATOR ${config.defaultValidator} but only ${config.validatorUrls.length} validators are listed`);
}
