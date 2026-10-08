const test = require('node:test');
const assert = require('node:assert/strict');

const RetryPolicy = require('../../../../src/core/execution/policy/retry-policy');
const RetryExecutor = require('../../../../src/core/execution/retry/retry-executor');
const CircuitBreaker = require('../../../../src/core/execution/circuit-breaker');

test('retry policy refuses authorization and validation failures', () => {
  const policy = new RetryPolicy({ maxAttempts: 2 });
  const tool = { name: 'send', retryable: true };

  assert.equal(
    policy.canRetry({
      tool,
      error: Object.assign(new Error('denied'), { code: 'TOOL_NOT_AUTHORIZED', status: 403 }),
      attempt: 0
    }).allowed,
    false
  );

  assert.equal(
    policy.canRetry({
      tool,
      error: Object.assign(new Error('bad input'), { code: 'INVALID_INPUT', status: 400 }),
      attempt: 0
    }).allowed,
    false
  );
});

test('retry executor retries transient failure and records failure classification', async () => {
  const events = [];
  let attempts = 0;
  const executor = new RetryExecutor({
    policy: new RetryPolicy({ maxAttempts: 2 }),
    circuitBreaker: new CircuitBreaker({ failureThreshold: 3 }),
    delay: async () => {}
  });

  const result = await executor.execute({
    tool: { name: 'unstable', retryable: true },
    context: { record(type, data) { events.push({ type, data }); } },
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary'), { code: 'TEMPORARY_FAILURE' });
      }
      return 'ok';
    }
  });

  assert.equal(result.result, 'ok');
  assert.equal(result.attempts, 2);
  assert.equal(events.filter(e => e.type === 'execution.retry.scheduled').length, 1);
  assert.equal(events.find(e => e.type === 'execution.retry.evaluated').data.failureClass, 'transient');
});

test('circuit breaker prevents retry storm across executions', async () => {
  let calls = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 1000,
    clock: () => 0
  });
  const executor = new RetryExecutor({
    policy: new RetryPolicy({ maxAttempts: 1 }),
    circuitBreaker: breaker,
    delay: async () => {}
  });
  const tool = { name: 'flaky', retryable: true };

  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      () => executor.execute({
        tool,
        execute: async () => {
          calls += 1;
          throw Object.assign(new Error('down'), { code: 'SERVICE_UNAVAILABLE', status: 503 });
        }
      }),
      /Retry attempts exhausted/
    );
  }

  await assert.rejects(
    () => executor.execute({
      tool,
      execute: async () => {
        calls += 1;
        return 'should-not-run';
      }
    }),
    { code: 'CIRCUIT_OPEN' }
  );

  assert.equal(calls, 2);
});
