const test = require('node:test');
const assert = require('node:assert/strict');

const CircuitBreaker = require('../../../../src/core/execution/circuit-breaker');

test('circuit opens after threshold and blocks subsequent calls', () => {
  let now = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 100,
    clock: () => now
  });

  breaker.beforeRequest('tool-a');
  breaker.recordFailure('tool-a');
  breaker.beforeRequest('tool-a');
  const opened = breaker.recordFailure('tool-a');

  assert.equal(opened.state, 'OPEN');
  assert.throws(() => breaker.beforeRequest('tool-a'), {
    code: 'CIRCUIT_OPEN'
  });
});

test('circuit transitions to half-open after reset and closes on success', () => {
  let now = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 100,
    clock: () => now
  });

  breaker.beforeRequest('tool-b');
  breaker.recordFailure('tool-b');
  assert.equal(breaker.status('tool-b').state, 'OPEN');

  now = 100;
  const probe = breaker.beforeRequest('tool-b');
  assert.equal(probe.state, 'HALF_OPEN');

  breaker.recordSuccess('tool-b');
  assert.equal(breaker.status('tool-b').state, 'CLOSED');
  assert.equal(breaker.status('tool-b').failures, 0);
});

test('half-open allows only the configured probe count', () => {
  let now = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    halfOpenMaxProbes: 1,
    clock: () => now
  });

  breaker.beforeRequest('tool-c');
  breaker.recordFailure('tool-c');
  now = 10;
  breaker.beforeRequest('tool-c');

  assert.throws(() => breaker.beforeRequest('tool-c'), {
    code: 'CIRCUIT_HALF_OPEN_LIMIT'
  });
});
