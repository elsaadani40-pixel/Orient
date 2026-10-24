'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;
const HASH = /^(?:[a-f0-9]{128}:[a-f0-9]{32}|legacy:[a-f0-9]{128}:[a-f0-9]{32})$/;
const MIN_PASSWORD = 14;

function passwordHash(password, salt = crypto.randomBytes(16)) {
  return crypto.scryptSync(password, salt, 64).toString('hex') + ':' + salt.toString('hex');
}
function matches(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string' || !HASH.test(encoded)) return false;
  const legacy = encoded.startsWith('legacy:');
  const normalized = legacy ? encoded.slice('legacy:'.length) : encoded;
  const [expected, salt] = normalized.split(':');
  // Legacy website owner.json used the hex salt as UTF-8 text.
  const actual = crypto.scryptSync(password, legacy ? salt : Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Canonical owner-only identity/session lifecycle. Both website and Runtime
 * adapters must use the same instance; public-user sessions are never accepted.
 * Bootstrap plaintext is returned only once to the caller and is never persisted.
 */
class OwnerIdentityService {
  constructor({ stateFile, bootstrapPassword, sessionTtlMs = 30 * 60 * 1000, now = Date.now } = {}) {
    if (typeof stateFile !== 'string' || !stateFile) throw new TypeError('stateFile is required');
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 86400000) throw new RangeError('Invalid session TTL');
    this.stateFile = path.resolve(stateFile);
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.sessions = new Map();
    this.createdBootstrap = false;
    this._bootstrapPassword = null;
    this.state = this.read();
    if (!this.state) {
      const secret = bootstrapPassword || crypto.randomBytes(24).toString('base64url');
      if (typeof secret !== 'string' || secret.length < MIN_PASSWORD || secret.length > 1024) throw new RangeError('Bootstrap password must be at least 14 characters');
      this.state = { version: 1, username: 'Admin', passwordHash: passwordHash(secret), mustChangePassword: true, sessions: [] };
      this._bootstrapPassword = secret;
      this.createdBootstrap = true;
      this.save();
    } else {
      for (const session of this.state.sessions) {
        if (!session || !/^[a-f0-9]{64}$/.test(session.digest) || !TOKEN.test(session.csrfToken) ||
            !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= this.now()) continue;
        this.sessions.set(session.digest, { csrfToken: session.csrfToken, expiresAt: session.expiresAt, sessionId: typeof session.sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.sessionId) ? session.sessionId : crypto.randomUUID() });
      }
      this.save();
    }
  }

  consumeBootstrapPassword() {
    const password = this._bootstrapPassword;
    this._bootstrapPassword = null;
    return password;
  }

  read() {
    let raw;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let value;
    try { value = JSON.parse(raw); } catch { throw Object.assign(new Error('Owner identity state is corrupt'), { code: 'OWNER_IDENTITY_STATE_INVALID' }); }
    if (raw.length > 2 * 1024 * 1024) throw Object.assign(new Error('Owner identity state exceeds the size limit'), { code: 'OWNER_IDENTITY_STATE_INVALID' });

    // One-time, lossless migration from the website's former owner.json shape.
    // Existing sessions are intentionally revoked; the old password verifier is
    // preserved until password rotation upgrades it to the canonical hash format.
    if (value?.version === 1 && value.username === 'Admin' &&
        value.password && typeof value.password === 'object' &&
        /^[a-f0-9]{128}$/.test(value.password.hash || '') &&
        /^[a-f0-9]{32}$/.test(value.password.salt || '') &&
        typeof value.mustChangePassword === 'boolean') {
      return {
        version: 1,
        username: 'Admin',
        passwordHash: 'legacy:' + value.password.hash + ':' + value.password.salt,
        mustChangePassword: value.mustChangePassword,
        sessions: []
      };
    }

    if (value?.version !== 1 || value.username !== 'Admin' ||
        typeof value.mustChangePassword !== 'boolean' || !HASH.test(value.passwordHash) ||
        !Array.isArray(value.sessions) || value.sessions.length > 4096) {
      throw Object.assign(new Error('Owner identity state schema is invalid'), { code: 'OWNER_IDENTITY_STATE_INVALID' });
    }
    return value;
  }

  save(next = this.state) {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const value = { ...next, sessions: [...this.sessions].map(([digest, session]) => ({ digest, ...session })) };
    const tmp = this.stateFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let fd = null;
    let renamed = false;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8');
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      fs.renameSync(tmp, this.stateFile);
      renamed = true;
      // Once rename succeeds, keep in-memory state aligned with the destination
      // even if the directory durability barrier fails. Callers must not roll
      // back session state as though the write never happened.
      this.state = value;
      try { fs.chmodSync(this.stateFile, 0o600); } catch {}

      // Node does not expose a portable directory-fsync operation on Windows.
      // Keep file fsync + atomic replacement there; on POSIX, require the
      // directory barrier and surface failures as committed-but-not-confirmed.
      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } catch (error) {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      if (!renamed) { try { fs.rmSync(tmp, { force: true }); } catch {} }
      throw Object.assign(new Error('Could not persist owner identity safely'), {
        code: 'OWNER_IDENTITY_PERSIST_FAILED',
        committed: renamed,
        cause: error
      });
    }
  }

  createSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.sessionTtlMs;
    const digest = tokenDigest(token);
    const sessionId = crypto.randomUUID();
    this.sessions.set(digest, { csrfToken, expiresAt, sessionId });
    try {
      this.save();
    } catch (error) {
      this.sessions.delete(digest);
      // A post-rename directory-sync error means the session was committed but
      // the caller will not receive its token. Attempt a compensating durable
      // write so that the unreachable session is not resurrected after restart.
      if (error.committed) {
        try { this.save(); } catch {}
      }
      throw error;
    }
    return { token, csrfToken, expiresAt };
  }

  async login({ username = 'Admin', password } = {}) {
    if (username !== 'Admin' || !matches(password, this.state.passwordHash)) return { ok: false, code: 'OWNER_LOGIN_FAILED' };
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 4096) return { ok: false, code: 'OWNER_SESSION_LIMIT_REACHED' };
    return { ok: true, ...this.createSession(), passwordChangeRequired: this.state.mustChangePassword };
  }

  authenticate(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const key = tokenDigest(token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) {
      if (session) { this.sessions.delete(key); this.save(); }
      return null;
    }
    return Object.freeze({ csrfToken: session.csrfToken, expiresAt: session.expiresAt, sessionId: session.sessionId });
  }

  isActiveSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const now = this.now();
    let changed = false;
    let active = false;
    for (const [digest, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(digest);
        changed = true;
      } else if (session.sessionId === sessionId) {
        active = true;
      }
    }
    if (changed) this.save();
    return active;
  }

  verifyCsrf(session, token) {
    if (!session || typeof token !== 'string') return false;
    const a = Buffer.from(session.csrfToken);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async changePassword({ token, password, confirmPassword } = {}) {
    if (!this.authenticate(token)) return { ok: false, code: 'OWNER_AUTH_REQUIRED' };
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 1024) return { ok: false, code: 'OWNER_PASSWORD_POLICY_REJECTED' };
    if (password !== confirmPassword) return { ok: false, code: 'OWNER_PASSWORD_CONFIRMATION_MISMATCH' };
    if (matches(password, this.state.passwordHash)) return { ok: false, code: 'OWNER_PASSWORD_REUSE_REJECTED' };
    const previous = this.sessions;
    this.sessions = new Map();
    const next = { ...this.state, passwordHash: passwordHash(password), mustChangePassword: false, passwordChangedAt: new Date(this.now()).toISOString() };
    try { this.save(next); } catch (error) { if (!error.committed) this.sessions = previous; throw error; }
    return { ok: true, ...this.createSession(), passwordChangeRequired: false };
  }

  logout(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false;
    const removed = this.sessions.delete(tokenDigest(token));
    if (removed) this.save();
    return removed;
  }

  revokeAllSessions() {
    const count = this.sessions.size;
    this.sessions.clear();
    this.save();
    return count;
  }

  status() {
    return { username: 'Admin', configured: true, passwordChangeRequired: this.state.mustChangePassword };
  }
}

module.exports = OwnerIdentityService;
