'use strict';

class OwnerIdentityRuntimeAdapter {
  constructor({ identity, maxFailures = 5, lockoutMs = 15 * 60 * 1000 } = {}) {
    if (!identity || typeof identity.login !== 'function' ||
        typeof identity.authenticate !== 'function' ||
        typeof identity.verifyCsrf !== 'function' ||
        typeof identity.changePassword !== 'function' ||
        typeof identity.logout !== 'function') {
      throw new TypeError('A compatible OwnerIdentityService instance is required');
    }
    if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100 ||
        !Number.isSafeInteger(lockoutMs) || lockoutMs < 1000 || lockoutMs > 86400000) {
      throw new RangeError('Invalid owner authentication adapter policy');
    }
    this.identity = identity;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
  }

  get enabled() {
    return this.identity.status().configured === true;
  }

  async login({ email, password, sourceIp = 'unknown' } = {}) {
    return this.identity.login({
      ...(email ? { email } : { username: 'Admin' }),
      password,
      sourceIp,
      maxFailures: this.maxFailures,
      lockoutMs: this.lockoutMs
    });
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
