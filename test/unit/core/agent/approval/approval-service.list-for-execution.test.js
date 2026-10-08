'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ApprovalService = require('../../../../../src/core/agent/approval/approval-service');

test('ApprovalService lists only active approvals for the execution tenant', async () => {
  let now = Date.parse('2026-10-09T00:00:00.000Z');
  const service = new ApprovalService({
    clock: () => now,
    tenantId: 'tenant-a'
  });

  const active = await service.issue({
    executionId: 'exec-1',
    step: 1,
    tool: 'tool-a',
    capability: 'cap-a',
    tenantId: 'tenant-a'
  });

  await service.issue({
    executionId: 'exec-1',
    step: 2,
    tool: 'tool-b',
    capability: 'cap-b',
    tenantId: 'tenant-b'
  });

  const expired = await service.issue({
    executionId: 'exec-1',
    step: 3,
    tool: 'tool-c',
    capability: 'cap-c',
    ttlMs: 1,
    tenantId: 'tenant-a'
  });
  now += 2;

  const approvals = await service.listForExecution({
    executionId: 'exec-1',
    tenantId: 'tenant-a'
  });

  assert.deepEqual(approvals.map(x => x.approvalId), [active.approvalId]);
  assert.equal(approvals[0].tool, 'tool-a');
  assert.equal(approvals[0].capability, 'cap-a');
  assert.equal(approvals[0].scope instanceof Object, true);
  assert.equal(Object.hasOwn(approvals[0], 'metadata'), false);
  assert.equal(Object.hasOwn(approvals[0], 'used'), false);
  assert.equal(Object.hasOwn(approvals[0], 'operationId'), false);
  void expired;
});
