const test = require('node:test');
const assert = require('node:assert/strict');

const RecoveryEngine =
  require('../../../../src/core/agent/recovery/recovery-engine');

test('timeout is classified as retryable', () => {
  const engine = new RecoveryEngine();
  const result = engine.recover({ code: 'TIMEOUT' });

  assert.equal(result.action, 'retry');
  assert.equal(result.metadata.retryable, true);
});

test('temporary failure is retryable', () => {
  const engine = new RecoveryEngine();
  const result = engine.recover({ code: 'TEMPORARY_FAILURE' });

  assert.equal(result.action, 'retry');
  assert.equal(result.metadata.retryable, true);
});

test('missing tool requires alternative', () => {
  const engine = new RecoveryEngine();
  const result = engine.recover({ code: 'TOOL_NOT_REGISTERED' });

  assert.equal(result.action, 'alternative');
  assert.equal(result.metadata.requiresAlternative, true);
});

test('approval failure produces approval recovery', () => {
  const engine = new RecoveryEngine();
  const result = engine.recover({ code: 'APPROVAL_REQUIRED' });

  assert.equal(result.action, 'approval');
  assert.equal(result.metadata.requiresApproval, true);
});

test('invalid input requests replanning', () => {
  const engine = new RecoveryEngine();
  const result = engine.recover({ code: 'INVALID_INPUT' });

  assert.equal(result.action, 'replan');
  assert.equal(result.metadata.replanRequired, true);
});

test('unknown failure safely aborts', () => {
  const engine = new RecoveryEngine();
  const result = engine.recover({ code: 'UNKNOWN_FAILURE' });

  assert.equal(result.action, 'abort');
  assert.equal(result.metadata.retryable, false);
});
