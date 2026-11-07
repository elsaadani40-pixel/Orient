'use strict';

const { createHash } = require('node:crypto');
const OwnerAuthService = require('../src/core/security/owner-auth-service');

const SESSION_TTL_MS = 30 * 60 * 1000;
const VALID_TOKEN = 'orient-fuzz-owner-session-token-00000000000000000000';
const VALID_CSRF = 'orient-fuzz-csrf-sentinel';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
let now = 1_000_000;

const auth = new OwnerAuthService({
  password: 'orient-fuzz-owner-password-2026',
  sessionTtlMs: SESSION_TTL_MS,
  now: () => now
});
const tokenDigest = createHash('sha256').update(VALID_TOKEN).digest('hex');

function seedActiveSession() {
  auth.sessions.clear();
  auth.sessions.set(tokenDigest, {
    id: SESSION_ID,
    csrfToken: VALID_CSRF,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
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
    id: SESSION_ID,
    csrfToken: VALID_CSRF,
    createdAt: now - SESSION_TTL_MS,
    expiresAt: now
  });
  if (auth.authenticate(VALID_TOKEN) !== null || auth.isActiveSession(SESSION_ID)) {
    throw new Error('An owner session must be expired at its exact expiry boundary');
  }
};
