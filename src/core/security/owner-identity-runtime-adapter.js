'use strict';

class OwnerIdentityRuntimeAdapter {
  constructor({ identity, maxFailures = 5, lockoutMs = 15 * 60 * 1000, now = Date.now } = {}) {
    if (!identity || typeof identity.login !== 'function' ||
        typeof identity.authenticate !== 'function' ||
        typeof identity.verifyCsrf !== 'function' ||
        typeof identity.changePassword !== 'function' ||
        typeof identity.logout !== 'function') {
      throw new TypeError('A compatible OwnerIdentityService instance is required');
    }
    if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100 ||
        !Number.isSafeInteger(lockoutMs) || lockoutMs < 1000 || lockoutMs > 86400000 ||
        typeof now !== 'function') {
      throw new RangeError('Invalid owner authentication adapter policy');
    }
    this.identity = identity;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.failures = new Map();
  }

  get enabled() {
    return this.identity.status().configured === true;
  }

  async login({ password, sourceIp = 'unknown' } = {}) {
    const ip = String(sourceIp || 'unknown').slice(0, 64);
    const now = this.now();
    const prior = this.failures.get(ip);
    if (prior && prior.blockedUntil > now) {
      return { ok: false, code: 'OWNER_LOGIN_RATE_LIMITED' };
    }

    const result = await this.identity.login({ username: 'Admin', password });
    if (result.ok) {
      this.failures.delete(ip);
      return result;
    }

    const withinWindow = prior && now - prior.windowStartedAt < this.lockoutMs;
    const count = withinWindow ? prior.count + 1 : 1;
    this.failures.delete(ip);
    if (this.failures.size >= 1024) this.failures.delete(this.failures.keys().next().value);
    this.failures.set(ip, {
      count,
      windowStartedAt: withinWindow ? prior.windowStartedAt : now,
      blockedUntil: count >= this.maxFailures ? now + this.lockoutMs : 0
    });
    return result;
  }

  status() {
    return this.identity.status();
  }

  authenticate(token) {
    return this.identity.authenticate(token);
  }

  isActiveSession(sessionId) {
    return this.identity.isActiveSession(sessionId);
  }

  verifyCsrf(session, token) {
    return this.identity.verifyCsrf(session, token);
  }

  async changePassword({ token, password, confirmPassword } = {}) {
    return this.identity.changePassword({ token, password, confirmPassword });
  }

  logout(token) {
    return this.identity.logout(token);
  }
}

module.exports = OwnerIdentityRuntimeAdapter;
