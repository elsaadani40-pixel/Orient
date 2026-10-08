const AppError = require('../errors/AppError');

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
});

class CircuitBreaker {
  constructor({
    failureThreshold = 3,
    resetTimeoutMs = 30000,
    halfOpenMaxProbes = 1,
    clock = () => Date.now()
  } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new TypeError('failureThreshold must be a positive integer');
    }
    if (!Number.isInteger(resetTimeoutMs) || resetTimeoutMs < 1) {
      throw new TypeError('resetTimeoutMs must be a positive integer');
    }
    if (!Number.isInteger(halfOpenMaxProbes) || halfOpenMaxProbes < 1) {
      throw new TypeError('halfOpenMaxProbes must be a positive integer');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');

    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenMaxProbes = halfOpenMaxProbes;
    this.clock = clock;
    this.entries = new Map();
  }

  _entry(key) {
    const normalized = String(key || 'default');
    if (!this.entries.has(normalized)) {
      this.entries.set(normalized, {
        state: STATES.CLOSED,
        failures: 0,
        openedAt: null,
        probes: 0
      });
    }
    return this.entries.get(normalized);
  }

  beforeRequest(key) {
    const entry = this._entry(key);
    const now = this.clock();

    if (entry.state === STATES.OPEN) {
      if (now - entry.openedAt < this.resetTimeoutMs) {
        throw new AppError(
          `Circuit is open for "${String(key)}"`,
          503,
          'CIRCUIT_OPEN'
        );
      }
      entry.state = STATES.HALF_OPEN;
      entry.probes = 0;
    }

    if (entry.state === STATES.HALF_OPEN) {
      if (entry.probes >= this.halfOpenMaxProbes) {
        throw new AppError(
          `Circuit probe limit reached for "${String(key)}"`,
          503,
          'CIRCUIT_HALF_OPEN_LIMIT'
        );
      }
      entry.probes += 1;
    }

    return Object.freeze({
      key: String(key || 'default'),
      state: entry.state,
      failures: entry.failures
    });
  }

  recordSuccess(key) {
    const entry = this._entry(key);
    entry.state = STATES.CLOSED;
    entry.failures = 0;
    entry.openedAt = null;
    entry.probes = 0;
    return this.status(key);
  }

  recordFailure(key) {
    const entry = this._entry(key);

    if (entry.state === STATES.HALF_OPEN) {
      entry.state = STATES.OPEN;
      entry.openedAt = this.clock();
      entry.probes = 0;
      return this.status(key);
    }

    entry.failures += 1;
    if (entry.failures >= this.failureThreshold) {
      entry.state = STATES.OPEN;
      entry.openedAt = this.clock();
      entry.probes = 0;
    }

    return this.status(key);
  }

  status(key) {
    const entry = this._entry(key);
    return Object.freeze({
      key: String(key || 'default'),
      state: entry.state,
      failures: entry.failures,
      openedAt: entry.openedAt,
      probes: entry.probes
    });
  }

  reset(key) {
    this.entries.delete(String(key || 'default'));
    return this.status(key);
  }
}

CircuitBreaker.STATES = STATES;
module.exports = CircuitBreaker;
