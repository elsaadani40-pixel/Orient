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
const fs = require('node:fs');
const path = require('node:path');

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function digestToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left || ''));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

class OwnerAuthService {
  constructor({
    password = process.env.ORIENT_OWNER_PASSWORD || '',
    sessionTtlMs = 30 * 60 * 1000,
    maxFailures = 5,
    maxSessions = 64,
    lockoutMs = 15 * 60 * 1000,
    stateFile = null,
    now = () => Date.now()
  } = {}) {
    if (password && (typeof password !== 'string' || password.length < 16)) {
      throw Object.assign(
        new Error('ORIENT_OWNER_PASSWORD must be at least 16 characters'),
        { code: 'OWNER_PASSWORD_TOO_WEAK' }
      );
    }
    this.enabled = Boolean(password);
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 24 * 60 * 60 * 1000) {
      throw new RangeError('sessionTtlMs must be from 1000 ms to 24 hours');
    }
    if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 1000) {
      throw new RangeError('maxFailures must be an integer from 1 to 1000');
    }
    if (!Number.isSafeInteger(lockoutMs) || lockoutMs < 1000 || lockoutMs > 24 * 60 * 60 * 1000) {
      throw new RangeError('lockoutMs must be from 1000 ms to 24 hours');
    }
    this.sessionTtlMs = sessionTtlMs;
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 4096) {
      throw new RangeError('maxSessions must be an integer from 1 to 4096');
    }
    this.maxFailures = maxFailures;
    this.maxSessions = maxSessions;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.stateFile = stateFile ? path.resolve(stateFile) : null;
    this.sessions = new Map();
    this.failures = new Map();
    this.loadState();
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

    const clearedFailure = this.failures.delete(ip);
    if (clearedFailure) this.persistState();
    this.pruneExpiredSessions(now);
    if (this.sessions.size >= this.maxSessions) {
      return { ok: false, code: 'OWNER_SESSION_LIMIT_REACHED' };
    }
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session = {
      id: randomUUID(),
      csrfToken,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs
    };
    const tokenDigest = digestToken(token);
    this.sessions.set(tokenDigest, session);
    try {
      this.persistState();
    } catch (error) {
      this.sessions.delete(tokenDigest);
      throw error;
    }
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
    const withinWindow = Boolean(existing && now - existing.windowStartedAt < this.lockoutMs);
    const count = withinWindow ? existing.count + 1 : 1;
    this.failures.set(ip, {
      count,
      windowStartedAt: withinWindow ? existing.windowStartedAt : now,
      blockedUntil: count >= this.maxFailures ? now + this.lockoutMs : 0
    });
    this.persistState();
  }

  loadState() {
    if (!this.stateFile) return;
    let raw;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const corrupt = message => Object.assign(new Error(message), { code: 'OWNER_AUTH_STATE_CORRUPT' });
    if (raw.length > 2 * 1024 * 1024) throw corrupt('Owner authentication state exceeds the size limit');
    let state;
    try { state = JSON.parse(raw); }
    catch (_) { throw corrupt('Owner authentication state is corrupt'); }
    if (state?.version !== 1 || !Array.isArray(state.sessions) || !Array.isArray(state.failures) ||
        state.sessions.length > this.maxSessions || state.failures.length > 1024) {
      throw corrupt('Owner authentication state has an unsupported schema or exceeds limits');
    }
    const now = this.now();
    for (const item of state.sessions) {
      if (!item || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) ||
          typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id) ||
          typeof item.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.csrfToken) ||
          !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || item.createdAt > now ||
          !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= item.createdAt ||
          item.expiresAt - item.createdAt > this.sessionTtlMs ||
          this.sessions.has(item.digest)) {
        throw corrupt('Owner authentication session state is invalid');
      }
      if (item.expiresAt > now) this.sessions.set(item.digest, { id: item.id, csrfToken: item.csrfToken, createdAt: item.createdAt, expiresAt: item.expiresAt });
    }
    for (const item of state.failures) {
      if (!item || typeof item.ip !== 'string' || item.ip.length < 1 || item.ip.length > 64 ||
          !Number.isInteger(item.count) || item.count < 1 || item.count > 100000 ||
          !Number.isSafeInteger(item.windowStartedAt) || item.windowStartedAt < 0 || item.windowStartedAt > now ||
          !Number.isSafeInteger(item.blockedUntil) || item.blockedUntil < 0 ||
          item.blockedUntil > item.windowStartedAt + this.lockoutMs ||
          this.failures.has(item.ip)) {
        throw corrupt('Owner authentication failure state is invalid');
      }
      this.failures.set(item.ip, { count: item.count, windowStartedAt: item.windowStartedAt, blockedUntil: item.blockedUntil });
    }
    this.pruneExpiredSessions(this.now());
  }

  persistState() {
    if (!this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch (_) { /* Platform permissions require deployment review. */ }
    const state = {
      version: 1,
      sessions: [...this.sessions.entries()].map(([digest, session]) => ({ digest, ...session })),
      failures: [...this.failures.entries()].map(([ip, failure]) => ({ ip, ...failure }))
    };
    const temporary = this.stateFile + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(temporary, 0o600); } catch (_) { /* Platform permissions require deployment review. */ }
      fs.renameSync(temporary, this.stateFile);
      try { fs.chmodSync(this.stateFile, 0o600); } catch (_) { /* Platform permissions require deployment review. */ }
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) { /* Preserve original error. */ }
      throw Object.assign(new Error('Could not persist owner authentication state'), { code: 'OWNER_AUTH_STATE_PERSIST_FAILED', cause: error });
    }
  }

  pruneExpiredSessions(now = this.now()) {
    let changed = false;
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) changed = this.sessions.delete(key) || changed;
    }
    if (changed) this.persistState();
  }

  authenticate(token) {
    this.pruneExpiredSessions();
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
    const removed = this.sessions.delete(digestToken(token));
    if (removed) this.persistState();
    return removed;
  }

  revokeAllSessions() {
    const count = this.sessions.size;
    this.sessions.clear();
    this.persistState();
    return count;
  }
}

module.exports = OwnerAuthService;
