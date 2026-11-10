'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;
const HASH = /^(?:[a-f0-9]{128}:[a-f0-9]{32}|legacy:[a-f0-9]{128}:[a-f0-9]{32})$/;
const MIN_PASSWORD = 14;
const MAX_OWNER_STATE_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_OWNER_EMAIL = 'elsaadani40@gmail.com';
function normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }

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

function readBoundedFile(fd, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
    if (count === 0) break;
    total += count;
  }
  if (total > maxBytes) {
    throw Object.assign(new Error('Owner identity state exceeds the size limit'), {
      code: 'OWNER_IDENTITY_STATE_INVALID'
    });
  }
  return buffer.subarray(0, total).toString('utf8');
}

/**
 * Canonical owner-only identity/session lifecycle. Both website and Runtime
 * adapters must use the same instance; public-user sessions are never accepted.
 * Bootstrap plaintext is returned only once to the caller and is never persisted.
 */
class OwnerIdentityService {
  constructor({ stateFile, bootstrapPassword, ownerEmail = process.env.ORIENT_OWNER_EMAIL || DEFAULT_OWNER_EMAIL, sessionTtlMs = 30 * 60 * 1000, maxLoginFailures = 5, loginLockoutMs = 15 * 60 * 1000, now = Date.now } = {}) {
    if (typeof stateFile !== 'string' || !stateFile) throw new TypeError('stateFile is required');
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 86400000) throw new RangeError('Invalid session TTL');
    this.stateFile = path.resolve(stateFile);
    this.ownerEmail = normalizeEmail(ownerEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.ownerEmail)) throw new TypeError('A valid canonical owner email is required');
    if (!Number.isInteger(maxLoginFailures) || maxLoginFailures < 1 || maxLoginFailures > 100 ||
        !Number.isSafeInteger(loginLockoutMs) || loginLockoutMs < 1000 || loginLockoutMs > 86400000) throw new RangeError('Invalid owner login protection policy');
    this.sessionTtlMs = sessionTtlMs;
    this.maxLoginFailures = maxLoginFailures;
    this.loginLockoutMs = loginLockoutMs;
    this.now = now;
    this.prepareStateDirectory();
    this.sessions = new Map();
    this.createdBootstrap = false;
    this._bootstrapPassword = null;
    this.state = this.read();
    this.loginFailureKeyFile = this.stateFile + '.lockout-key';
    this.loginFailureKeySecret = this.loadLoginFailureSecret();
    this.loginFailures = new Map((this.state?.loginFailures || []).map(({ key, ...failure }) => [key, {
      ...failure,
      // Records written before key separation used the password verifier as
      // their HMAC key. Keep them recognizable until their lockout window expires.
      keyVersion: failure.keyVersion === undefined ? 1 : failure.keyVersion
    }]));
    if (!this.state) {
      const secret = bootstrapPassword || crypto.randomBytes(24).toString('base64url');
      if (typeof secret !== 'string' || secret.length > 1024 || (!/^\d{10}$/.test(secret) && secret.length < MIN_PASSWORD)) throw new RangeError('Bootstrap password must be exactly 10 digits or at least 14 characters');
      this.state = { version: 1, username: 'Admin', email: this.ownerEmail, passwordHash: passwordHash(secret), mustChangePassword: true, sessions: [], loginFailures: [] };
      this._bootstrapPassword = secret;
      this.createdBootstrap = true;
      this.save();
    } else {
      if (this.state.email !== this.ownerEmail) { this.state = { ...this.state, email: this.ownerEmail }; this.save(); }
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

  prepareStateDirectory() {
    const configuredDirectory = path.dirname(this.stateFile);
    fs.mkdirSync(configuredDirectory, { recursive: true, mode: 0o700 });
    const configuredStats = fs.lstatSync(configuredDirectory, { bigint: true });
    if (!configuredStats.isDirectory() || configuredStats.isSymbolicLink()) {
      throw Object.assign(new Error('Owner identity directory must not be a symbolic link'), {
        code: 'OWNER_IDENTITY_STORAGE_DIRECTORY_INVALID'
      });
    }

    // Resolve trusted platform path aliases once, then use only the canonical path.
    const directory = fs.realpathSync(configuredDirectory);
    const directoryStats = fs.lstatSync(directory, { bigint: true });
    const parentDirectory = path.dirname(directory);
    const parentStats = fs.lstatSync(parentDirectory, { bigint: true });
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
        !parentStats.isDirectory() || parentStats.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory ||
        fs.realpathSync(parentDirectory) !== parentDirectory) {
      throw Object.assign(new Error('Owner identity directory must be a real canonical directory'), {
        code: 'OWNER_IDENTITY_STORAGE_DIRECTORY_INVALID'
      });
    }

    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      if (directoryStats.uid !== BigInt(process.getuid())) {
        throw Object.assign(new Error('Owner identity directory must be owned by the application user'), {
          code: 'OWNER_IDENTITY_STORAGE_DIRECTORY_OWNER_INVALID'
        });
      }
      const parentMode = parentStats.mode & 0o7777n;
      if ((parentMode & 0o022n) !== 0n && (parentMode & 0o1000n) === 0n) {
        throw Object.assign(new Error('Owner identity parent directory is writable by other users without sticky-bit protection'), {
          code: 'OWNER_IDENTITY_STORAGE_PARENT_UNTRUSTED'
        });
      }
      if ((directoryStats.mode & 0o077n) !== 0n) fs.chmodSync(directory, 0o700);
      const privateStats = fs.lstatSync(directory, { bigint: true });
      if ((privateStats.mode & 0o077n) !== 0n) {
        throw Object.assign(new Error('Owner identity directory must be private (mode 0700)'), {
          code: 'OWNER_IDENTITY_STORAGE_DIRECTORY_PERMISSIONS_INVALID'
        });
      }
    }

    this.stateFile = path.join(directory, path.basename(this.stateFile));
    this.loginFailureKeyFile = this.stateFile + '.lockout-key';
  }

  read() {
    let descriptor;
    let raw;
    const invalid = message => Object.assign(new Error(message), {
      code: 'OWNER_IDENTITY_STATE_INVALID'
    });

    try {
      const noFollow = fs.constants.O_NOFOLLOW;
      if (typeof noFollow !== 'number') {
        // Windows relies on the deployment ACL for race protection; still reject
        // an already-present reparse-point/symlink before opening the file.
        let pathStats;
        try { pathStats = fs.lstatSync(this.stateFile); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
          throw invalid('Owner identity state must be a regular non-symbolic-link file');
        }
      }

      try {
        descriptor = fs.openSync(
          this.stateFile,
          fs.constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0)
        );
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'ELOOP' || error.code === 'EMLINK') {
          throw invalid('Owner identity state must not be a symbolic link');
        }
        throw error;
      }

      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || stats.nlink !== 1) {
        throw invalid('Owner identity state must be a single-link regular file');
      }
      if (stats.size > MAX_OWNER_STATE_FILE_BYTES) {
        throw invalid('Owner identity state exceeds the size limit');
      }
      if (process.platform !== 'win32' && typeof process.getuid === 'function') {
        if (stats.uid !== process.getuid()) {
          throw invalid('Owner identity state must be owned by the application user');
        }
        if ((stats.mode & 0o077) !== 0) {
          fs.fchmodSync(descriptor, 0o600);
          if ((fs.fstatSync(descriptor).mode & 0o077) !== 0) {
            throw invalid('Owner identity state must be private (mode 0600)');
          }
        }
      }
      raw = readBoundedFile(descriptor, MAX_OWNER_STATE_FILE_BYTES);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }

    let value;
    try { value = JSON.parse(raw); }
    catch { throw invalid('Owner identity state is corrupt'); }

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
        email: this.ownerEmail,
        passwordHash: 'legacy:' + value.password.hash + ':' + value.password.salt,
        mustChangePassword: value.mustChangePassword,
        sessions: [],
        loginFailures: []
      };
    }

    if (value?.version !== 1 || value.username !== 'Admin' ||
        typeof value.mustChangePassword !== 'boolean' || !HASH.test(value.passwordHash) ||
        !Array.isArray(value.sessions) || value.sessions.length > 4096) {
      throw invalid('Owner identity state schema is invalid');
    }
    const failures = value.loginFailures === undefined ? [] : value.loginFailures;
    if (!Array.isArray(failures) || failures.length > 1024) {
      throw invalid('Owner identity login-failure state is invalid');
    }
    const seenFailureKeys = new Set();
    for (const item of failures) {
      if (!item || !/^[a-f0-9]{64}$/.test(item.key || '') || seenFailureKeys.has(item.key) ||
          !Number.isInteger(item.count) || item.count < 1 || item.count > 100 ||
          !Number.isSafeInteger(item.windowStartedAt) || item.windowStartedAt < 0 || item.windowStartedAt > this.now() ||
          !Number.isSafeInteger(item.blockedUntil) || item.blockedUntil < 0 ||
          item.blockedUntil > this.now() + 86400000 ||
          (item.keyVersion !== undefined && item.keyVersion !== 1 && item.keyVersion !== 2)) {
        throw invalid('Owner identity login-failure state is invalid');
      }
      seenFailureKeys.add(item.key);
    }
    value.loginFailures = failures;
    return value;
  }

  save(next = this.state) {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const value = {
      ...next,
      sessions: [...this.sessions].map(([digest, session]) => ({ digest, ...session })),
      loginFailures: [...this.loginFailures].map(([key, failure]) => ({ key, ...failure }))
    };
    const tmp = this.stateFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let fd = null;
    let renamed = false;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8');
      try { fs.fchmodSync(fd, 0o600); } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
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

  loadLoginFailureSecret() {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (error) {
      if (process.platform !== 'win32') {
        throw Object.assign(new Error('Could not protect owner identity directory'), {
          code: 'OWNER_LOCKOUT_KEY_PERSIST_FAILED',
          cause: error
        });
      }
    }

    const readExisting = () => {
      let fd;
      try {
        // Open first, then validate the opened descriptor. On POSIX, O_NOFOLLOW
        // makes the open itself reject symlinks, avoiding a separate lstat/open
        // check-then-use race. Node does not expose O_NOFOLLOW on Windows;
        // there, protection against path replacement depends on the deployment
        // ACL restricting this directory to the service account. chmod(0700)
        // is not an ACL boundary on Windows; fstat still validates the handle.
        const noFollow = fs.constants.O_NOFOLLOW;
        try {
          fd = fs.openSync(
            this.loginFailureKeyFile,
            fs.constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0)
          );
        } catch (error) {
          if (error.code === 'ELOOP' || error.code === 'EMLINK') {
            throw Object.assign(new Error('Owner lockout key file must not be a symbolic link'), {
              code: 'OWNER_LOCKOUT_KEY_INVALID',
              cause: error
            });
          }
          throw error;
        }
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64) {
          throw Object.assign(new Error('Owner lockout key file is invalid'), { code: 'OWNER_LOCKOUT_KEY_INVALID' });
        }
        const encoded = fs.readFileSync(fd, 'utf8');
        if (!/^[a-f0-9]{64}$/.test(encoded)) {
          throw Object.assign(new Error('Owner lockout key file is invalid'), { code: 'OWNER_LOCKOUT_KEY_INVALID' });
        }
        try { fs.fchmodSync(fd, 0o600); } catch (error) {
          if (process.platform !== 'win32') throw error;
        }
        return Buffer.from(encoded, 'hex');
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    };

    try {
      return readExisting();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // A missing key must never silently invalidate active v2 lockouts. Legacy
    // records remain usable because their old verifier-derived digest can still
    // be checked until those records expire or a password rotation clears them.
    if ((this.state?.loginFailures || []).some(item => item.keyVersion === 2)) {
      throw Object.assign(new Error('Owner lockout key is missing while protected failure records exist'), {
        code: 'OWNER_LOCKOUT_KEY_UNAVAILABLE'
      });
    }

    const secret = crypto.randomBytes(32);
    let fd;
    let created = false;
    try {
      fd = fs.openSync(this.loginFailureKeyFile, 'wx', 0o600);
      fs.writeFileSync(fd, secret.toString('hex'), 'utf8');
      try { fs.fchmodSync(fd, 0o600); } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      created = true;

      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
      return secret;
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (error.code === 'EEXIST') return readExisting();
      if (!created) { try { fs.rmSync(this.loginFailureKeyFile, { force: true }); } catch {} }
      throw Object.assign(new Error('Could not persist owner lockout key safely'), {
        code: 'OWNER_LOCKOUT_KEY_PERSIST_FAILED',
        committed: created,
        cause: error
      });
    }
  }

  loginFailureKey(sourceIp) {
    const ip = String(sourceIp || 'unknown').slice(0, 64);
    return crypto.createHmac('sha256', this.loginFailureKeySecret).update(ip).digest('hex');
  }

  legacyLoginFailureKey(sourceIp) {
    const ip = String(sourceIp || 'unknown').slice(0, 64);
    return crypto.createHmac('sha256', this.state.passwordHash).update(ip).digest('hex');
  }

  pruneLoginFailures(now = this.now()) {
    const previous = new Map(this.loginFailures);
    let changed = false;
    for (const [key, failure] of this.loginFailures) {
      if (failure.windowStartedAt + this.loginLockoutMs <= now && failure.blockedUntil <= now) {
        this.loginFailures.delete(key);
        changed = true;
      }
    }
    if (changed) {
      try { this.save(); }
      catch (error) {
        if (!error.committed) this.loginFailures = previous;
        throw error;
      }
    }
  }

  recordLoginFailure(key, now, maxFailures, lockoutMs, keyVersion = 2) {
    const previous = this.loginFailures.get(key);
    if (!previous && this.loginFailures.size >= 1024) return { ok: false, code: 'OWNER_LOGIN_RATE_LIMITED' };
    const withinWindow = previous && now - previous.windowStartedAt < lockoutMs;
    const count = withinWindow ? previous.count + 1 : 1;
    const prior = previous;
    this.loginFailures.set(key, {
      count,
      windowStartedAt: withinWindow ? previous.windowStartedAt : now,
      blockedUntil: count >= maxFailures ? now + lockoutMs : 0,
      keyVersion
    });
    try { this.save(); }
    catch (error) { if (!error.committed) { if (prior) this.loginFailures.set(key, prior); else this.loginFailures.delete(key); } throw error; }
    return { ok: false, code: 'OWNER_LOGIN_FAILED' };
  }

  async login({ username = 'Admin', email, password, sourceIp = 'unknown', maxFailures = this.maxLoginFailures, lockoutMs = this.loginLockoutMs, now = this.now() } = {}) {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid owner login clock');
    if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100 ||
        !Number.isSafeInteger(lockoutMs) || lockoutMs < 1000 || lockoutMs > 86400000) throw new RangeError('Invalid owner login protection policy');
    this.pruneLoginFailures(now);
    const failureKey = this.loginFailureKey(sourceIp);
    const legacyFailureKey = this.legacyLoginFailureKey(sourceIp);
    const currentPrior = this.loginFailures.get(failureKey);
    const legacyPrior = this.loginFailures.get(legacyFailureKey);
    if (currentPrior?.blockedUntil > now || legacyPrior?.blockedUntil > now) {
      return { ok: false, code: 'OWNER_LOGIN_RATE_LIMITED' };
    }
    if (!currentPrior && !legacyPrior && this.loginFailures.size >= 1024) {
      return { ok: false, code: 'OWNER_LOGIN_RATE_LIMITED' };
    }
    const selectedFailureKey = currentPrior ? failureKey : legacyPrior ? legacyFailureKey : failureKey;
    const selectedKeyVersion = currentPrior ? 2 : legacyPrior ? 1 : 2;
    const validIdentity = email !== undefined ? normalizeEmail(email) === this.state.email : username === 'Admin';
    const validPassword = matches(password, this.state.passwordHash);
    if (!validIdentity || !validPassword) {
      return this.recordLoginFailure(selectedFailureKey, now, maxFailures, lockoutMs, selectedKeyVersion);
    }
    if (currentPrior || legacyPrior) {
      this.loginFailures.delete(failureKey);
      this.loginFailures.delete(legacyFailureKey);
      try { this.save(); }
      catch (error) {
        if (!error.committed) {
          if (currentPrior) this.loginFailures.set(failureKey, currentPrior);
          if (legacyPrior) this.loginFailures.set(legacyFailureKey, legacyPrior);
        }
        throw error;
      }
    }
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
    const previousFailures = this.loginFailures;
    this.sessions = new Map();
    this.loginFailures = new Map();
    const next = { ...this.state, passwordHash: passwordHash(password), mustChangePassword: false, passwordChangedAt: new Date(this.now()).toISOString() };
    try { this.save(next); } catch (error) { if (!error.committed) { this.sessions = previous; this.loginFailures = previousFailures; } throw error; }
    return { ok: true, ...this.createSession(), passwordChangeRequired: false };
  }

  logout(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false;
    const digest = tokenDigest(token);
    const previous = this.sessions.get(digest);
    if (!previous) return false;

    this.sessions.delete(digest);
    try {
      this.save();
    } catch (error) {
      // Before rename, disk still contains the active session. Restore memory
      // to that same committed state; after rename, keep the revocation applied.
      if (!error.committed) this.sessions.set(digest, previous);
      throw error;
    }
    return true;
  }

  revokeAllSessions() {
    const previous = new Map(this.sessions);
    const count = previous.size;
    this.sessions.clear();
    try {
      this.save();
    } catch (error) {
      if (!error.committed) {
        for (const [digest, session] of previous) this.sessions.set(digest, session);
      }
      throw error;
    }
    return count;
  }

  status() {
    return { username: 'Admin', email: this.state.email, configured: true, passwordChangeRequired: this.state.mustChangePassword };
  }
}

module.exports = OwnerIdentityService;
