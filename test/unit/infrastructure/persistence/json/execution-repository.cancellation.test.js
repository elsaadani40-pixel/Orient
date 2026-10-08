'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExecutionRepository = require('../../../../../src/infrastructure/persistence/json/execution.repository');

test('execution cancellation is durable, tenant-scoped, and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-cancel-'));
  const repository = new ExecutionRepository(path.join(dir, 'executions.json'));

  repository.insert({
    executionId: 'exec-a',
    requestId: 'req-a',
    status: 'running',
    metadata: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' });

  repository.insert({
    executionId: 'exec-b',
    requestId: 'req-b',
    status: 'running',
    metadata: { tenantId: 'tenant-b' }
  }, { tenantId: 'tenant-b' });

  const requested = repository.requestCancellation('exec-a', 'user requested stop', {
    tenantId: 'tenant-a'
  });

  assert.equal(requested.cancellationRequested, true);
  assert.equal(requested.cancellationReason, 'user requested stop');
  assert.equal(requested.status, 'running');

  const repeated = repository.requestCancellation('exec-a', 'different reason', {
    tenantId: 'tenant-a'
  });
  assert.equal(repeated.cancellationRequested, true);
  assert.equal(repeated.cancellationReason, 'different reason');

  assert.equal(repository.requestCancellation('exec-a', 'cross tenant', {
    tenantId: 'tenant-b'
  }), null);

  const persisted = repository.findById('exec-a', { tenantId: 'tenant-a' });
  assert.equal(persisted.cancellationRequested, true);
  assert.equal(persisted.cancellationReason, 'different reason');
});
