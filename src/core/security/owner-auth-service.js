'use strict';

const {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  scryptSync,
  timingSafeEqual
} = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function digestToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

class OwnerAuthService {
  constructor({
    password = process.env.ORIENT_OWNER_PASSWORD || '',
    sessionTtlMs = 30 * 60 * 1000,
    maxFailures = 5,
    lockoutMs = 15 * 60 * 1000,
    now = () => Date.now()
  } = {}) {
    if (password && (typeof password !== 'string' || password.length < 16)) {
      throw Object.assign(
        new Error('ORIENT_OWNER_PASSWORD must be at least 16 characters'),
        { code: 'OWNER_PASSWORD_TOO_WEAK' }
      );
    }
    this.enabled = Boolean(password);
    this.sessionTtlMs = sessionTtlMs;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.sessions = new Map();
    this.failures = new Map();
    this.passwordSalt = this.enabled ? randomBytes(16) : null;
    this.passwordVerifier = this.enabled
      ? scryptSync(password, this.passwordSalt, KEY_LENGTH, SCRYPT_OPTIONS)
      : null;
  }

  async login({ password, sourceIp = 'unknown' } = {}) {
    if (!this.enabled) {
      return { ok: false, code: 'OWNER_AUTH_NOT_CONFIGURED' };
    }
    const ip = String(sourceIp || 'unknown').slice(0, 64);
    const now = this.now();
    const failure = this.failures.get(ip);
    if (failure && failure.blockedUntil > now) {
      return { ok: false, code: 'OWNER_LOGIN_RATE_LIMITED' };
    }

    const candidate = typeof password === 'string' && password.length <= 1024
      ? await scryptAsync(password, this.passwordSalt, KEY_LENGTH, SCRYPT_OPTIONS)
      : Buffer.alloc(KEY_LENGTH);
    const matches = safeEqual(candidate, this.passwordVerifier);
    if (!matches) {
      this.recordFailure(ip, now);
      return { ok: false, code: 'OWNER_LOGIN_FAILED' };
    }

    this.failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session = {
      id: randomUUID(),
      csrfToken,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs
    };
    this.sessions.set(digestToken(token), session);
    return {
      ok: true,
      token,
      csrfToken,
      expiresAt: session.expiresAt,
      sessionId: session.id
    };
  }

  recordFailure(ip, now) {
    if (this.failures.size >= 1024 && !this.failures.has(ip)) {
      this.failures.delete(this.failures.keys().next().value);
    }
    const existing = this.failures.get(ip);
    const count = existing && now - existing.windowStartedAt < this.lockoutMs
      ? existing.count + 1
      : 1;
    this.failures.set(ip, {
      count,
      windowStartedAt: existing?.windowStartedAt || now,
      blockedUntil: count >= this.maxFailures ? now + this.lockoutMs : 0
    });
  }

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 100) return null;
    const key = digestToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return Object.freeze({
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt
    });
  }

  verifyCsrf(session, token) {
    return Boolean(session && typeof token === 'string' && safeEqual(session.csrfToken, token));
  }

  logout(token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 100) return false;
    return this.sessions.delete(digestToken(token));
  }

  revokeAllSessions() {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }
}

module.exports = OwnerAuthService;
