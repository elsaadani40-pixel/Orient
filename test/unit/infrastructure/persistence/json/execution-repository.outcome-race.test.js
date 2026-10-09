'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ExecutionRepository = require('../../../../../src/infrastructure/persistence/json/execution.repository');

test('durable cancellation wins a terminal completion race', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-outcome-'));
  const repository = new ExecutionRepository(path.join(dir, 'executions.json'));

  repository.insert({
    executionId: 'exec-race',
    requestId: 'req-race',
    status: 'running',
    metadata: { tenantId: 'tenant-a' },
    result: null
  }, { tenantId: 'tenant-a' });

  repository.requestCancellation('exec-race', 'stop before commit', {
    tenantId: 'tenant-a'
  });

  const attemptedCompletion = repository.update('exec-race', {
    status: 'completed',
    result: { value: 'must-not-win' },
    completedAt: new Date().toISOString()
  }, { tenantId: 'tenant-a' });

  assert.equal(attemptedCompletion.status, 'running');
  assert.equal(attemptedCompletion.cancellationRequested, true);
  assert.equal(attemptedCompletion.result, null);

  const durable = repository.findById('exec-race', { tenantId: 'tenant-a' });
  assert.equal(durable.status, 'running');
  assert.equal(durable.cancellationRequested, true);
  assert.equal(durable.result, null);

  const attemptedFailure = repository.update('exec-race', {
    status: 'failed',
    error: { code: 'TOOL_FAILED' },
    completedAt: new Date().toISOString()
  }, { tenantId: 'tenant-a' });

  assert.equal(attemptedFailure.status, 'running');
  assert.equal(attemptedFailure.cancellationRequested, true);
  assert.equal(attemptedFailure.result, null);
});
