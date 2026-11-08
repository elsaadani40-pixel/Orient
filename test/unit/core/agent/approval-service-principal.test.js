'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');
const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');

test('approval service forwards the immutable owner principal to every durable operation', async () => {
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    sessionId: 'session-a'
  });
  const calls = [];
  const approval = {
    approvalId: 'approval-a',
    executionId: 'execution-a',
    tenantId: 'tenant-a',
    step: 1,
    planRevision: 1,
    tool: 'safe-tool',
    capability: 'safe:read',
    scope: {},
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    used: false,
    metadata: {}
  };
  const repository = {
    async save(value, options) { calls.push(['save', options.persistencePrincipal]); return value; },
    async findById(id, options) { calls.push(['findById', options.persistencePrincipal]); return { ...approval, decision: null }; },
    async findByExecution(options) { calls.push(['findByExecution', options.persistencePrincipal]); return [{ ...approval, decision: { status: 'approved', actorId: 'session-a' } }]; },
    async findPending(options) { calls.push(['findPending', options.persistencePrincipal]); return [approval]; },
    async recordDecision(id, decision, tenantId, clock, identity) { calls.push(['recordDecision', identity]); return { ...approval, decision }; },
    async consume(id, usedAt, tenantId, options) { calls.push(['consume', options.persistencePrincipal]); return true; }
  };
  const service = new ApprovalService({
    repository,
    tenantId: 'tenant-a',
    decisionAuthorizer: async () => true
  });

  await service.issue({
    executionId: 'execution-a', step: 1, tool: 'safe-tool', capability: 'safe:read',
    tenantId: 'tenant-a', persistencePrincipal: principal
  });
  await service.listForExecution({ executionId: 'execution-a', tenantId: 'tenant-a', persistencePrincipal: principal });
  await service.listPending({ tenantId: 'tenant-a', persistencePrincipal: principal });
  await service.decide({
    approvalId: 'approval-a', executionId: 'execution-a', decision: 'approved',
    actorId: 'session-a', tenantId: 'tenant-a', persistencePrincipal: principal
  });
  await service.getApprovedForExecution({
    approvalId: 'approval-a', executionId: 'execution-a', tenantId: 'tenant-a',
    persistencePrincipal: principal
  });
  await service.consume('approval-a', 'tenant-a', principal);

  assert.deepEqual(calls.map(([method]) => method), [
    'save', 'findByExecution', 'findPending', 'findById',
    'recordDecision', 'findById', 'findById', 'consume'
  ]);
  assert.ok(calls.every(([, identity]) => identity === principal));
});
