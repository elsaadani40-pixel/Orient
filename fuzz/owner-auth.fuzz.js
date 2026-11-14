'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OwnerIdentityService = require('../src/core/security/owner-identity-service');

const SESSION_TTL_MS = 30 * 60 * 1000;
const VALID_TOKEN = 'orient-fuzz-owner-session-token-00000000000000000000';
const VALID_CSRF = 'orient-fuzz-csrf-sentinel';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
let now = 1_000_000;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-identity-fuzz-'));
const auth = new OwnerIdentityService({
  stateFile: path.join(directory, 'owner.json'),
  bootstrapPassword: 'orient-fuzz-owner-bootstrap-password-2026!',
  sessionTtlMs: SESSION_TTL_MS,
  now: () => now
});
const tokenDigest = crypto.createHash('sha256').update(VALID_TOKEN).digest('hex');

// Persistence has dedicated deterministic tests. Keep this campaign focused on
// token/CSRF/session semantics instead of fsyncing the state file per input.
auth.save = () => {};

process.on('exit', () => {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
});

function seedActiveSession() {
  auth.sessions.clear();
  auth.sessions.set(tokenDigest, {
    csrfToken: VALID_CSRF,
    expiresAt: now + SESSION_TTL_MS,
    sessionId: SESSION_ID
  });
}

module.exports.fuzz = function fuzz(data) {
  now = 1_000_000;
  seedActiveSession();

  // Fuzz token and CSRF inputs independently; the first pipe separates the fields.
  const separator = data.indexOf(0x7c);
  const tokenInput = (separator < 0 ? data : data.subarray(0, separator)).toString('utf8');
  const csrfInput = separator < 0 ? '' : data.subarray(separator + 1).toString('utf8');

  const authenticated = auth.authenticate(tokenInput);
  if (tokenInput === VALID_TOKEN) {
    if (!authenticated || authenticated.sessionId !== SESSION_ID) {
      throw new Error('A valid issued-session token must authenticate to its owner session');
    }
  } else if (authenticated !== null) {
    throw new Error('An unknown token must never authenticate');
  }

  const csrfAccepted = auth.verifyCsrf(authenticated, csrfInput);
  const expectedCsrf = tokenInput === VALID_TOKEN && csrfInput === VALID_CSRF;
  if (csrfAccepted !== expectedCsrf) {
    throw new Error('CSRF verification must require both an authenticated session and its exact token');
  }

  if (!auth.isActiveSession(SESSION_ID)) {
    throw new Error('A non-expired seeded owner session must be active');
  }

  const loggedOut = auth.logout(tokenInput);
  if (loggedOut !== (tokenInput === VALID_TOKEN)) {
    throw new Error('Logout must revoke only the matching session token');
  }
  const remainingSession = auth.authenticate(VALID_TOKEN);
  if (tokenInput === VALID_TOKEN ? remainingSession !== null
    : !remainingSession || remainingSession.sessionId !== SESSION_ID) {
    throw new Error('Logout must revoke only the matching owner session');
  }

  // Expiry is checked at the exact boundary, not only after it.
  now += SESSION_TTL_MS;
  auth.sessions.clear();
  auth.sessions.set(tokenDigest, {
    csrfToken: VALID_CSRF,
    expiresAt: now,
    sessionId: SESSION_ID
  });
  if (auth.authenticate(VALID_TOKEN) !== null || auth.isActiveSession(SESSION_ID)) {
    throw new Error('An owner session must be expired at its exact expiry boundary');
  }
};
