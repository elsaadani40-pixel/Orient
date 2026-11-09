'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');

function runtimeFixture(overrides = {}) {
  const calls = [];
  const runtime = Object.create(OrientRuntime.prototype);
  runtime.tenantId = 'tenant-a';
  runtime.requestExecutionCoordinator = {
    async resume(executionId, options) {
      calls.push({ kind: 'resume', executionId, options });
      if (overrides.resumeError) throw overrides.resumeError;
      return overrides.resumeResult || { execution: { status: 'completed' }, result: { ok: true } };
    }
  };
  runtime.workflowExecutionCoordinator = {
    async findApprovalBlockedWorkflow(executionId, persistencePrincipal) {
      calls.push({ kind: 'findBlocked', executionId, persistencePrincipal });
      return { metadata: { approvalId: overrides.currentApprovalId || 'approval-a' } };
    },
    async reconcileApprovalResume(executionId, result, persistencePrincipal) {
      calls.push({ kind: 'reconcileResume', executionId, result, persistencePrincipal });
      return true;
    },
    async updateApprovalChallenge(executionId, approvalId, persistencePrincipal) {
      calls.push({ kind: 'updateChallenge', executionId, approvalId, persistencePrincipal });
      return true;
    },
    async expireApprovalWorkflow(executionId, approvalId, persistencePrincipal) {
      calls.push({ kind: 'expireWorkflow', executionId, approvalId, persistencePrincipal });
      return true;
    },
    async cancelApprovalWorkflow(executionId, reason, persistencePrincipal) {
      calls.push({ kind: 'cancelWorkflow', executionId, reason, persistencePrincipal });
      return true;
    }
  };
  runtime.persistence = {
    executions: {
      async requestCancellation(executionId, reason, options) {
        calls.push({ kind: 'requestCancellation', executionId, reason, options });
        return { executionId, status: 'cancelled' };
      },
      async findById() {
        return null;
      }
    }
  };
  runtime.approvalService = {
    async decide(options) {
      calls.push({ kind: 'decide', options });
      if (overrides.decideError) throw overrides.decideError;
      return { approvalId: options.approvalId, decision: { status: options.decision } };
    }
  };
  return { runtime, calls };
}

test('Runtime reconciles the durable workflow after a successful owner resume', async () => {
  const { runtime, calls } = runtimeFixture();
  const result = await runtime.resume('execution-a', { approval: { approvalId: 'approval-a' } });
  assert.equal(result.execution.status, 'completed');
  assert.ok(calls.some(call => call.kind === 'reconcileResume' && call.executionId === 'execution-a'));
});

test('Runtime persists a newly issued approval challenge before returning the error', async () => {
  const error = Object.assign(new Error('Approval required'), {
    code: 'APPROVAL_REQUIRED',
    executionContext: { approvalId: 'approval-next' }
  });
  const { runtime, calls } = runtimeFixture({ resumeError: error });
  await assert.rejects(runtime.resume('execution-a'), e => e === error);
  assert.ok(calls.some(call => call.kind === 'updateChallenge' &&
    call.executionId === 'execution-a' && call.approvalId === 'approval-next'));
});

test('Runtime reconciles expired approval into durable execution cancellation and workflow state', async () => {
  const error = Object.assign(new Error('Approval expired'), {
    code: 'APPROVAL_EXPIRED',
    approvalId: 'approval-a'
  });
  const { runtime, calls } = runtimeFixture({ resumeError: error });
  await assert.rejects(runtime.resume('execution-a'), e => e === error);
  assert.ok(calls.some(call => call.kind === 'requestCancellation' &&
    call.executionId === 'execution-a' && call.reason === 'approval_expired'));
  assert.ok(calls.some(call => call.kind === 'expireWorkflow' &&
    call.executionId === 'execution-a' && call.approvalId === 'approval-a'));
});

test('Runtime refuses to expire an older approval challenge after a newer challenge replaced it', async () => {
  const error = Object.assign(new Error('Approval expired'), {
    code: 'APPROVAL_EXPIRED',
    approvalId: 'approval-old'
  });
  const { runtime, calls } = runtimeFixture({ resumeError: error, currentApprovalId: 'approval-new' });
  await assert.rejects(runtime.resume('execution-a'), e => e === error);
  assert.ok(!calls.some(call => call.kind === 'requestCancellation'));
  assert.ok(!calls.some(call => call.kind === 'expireWorkflow'));
});

test('Runtime reconciles expiry reported while recording the owner decision', async () => {
  const error = Object.assign(new Error('Approval expired'), {
    code: 'APPROVAL_EXPIRED',
    approvalId: 'approval-a'
  });
  const { runtime, calls } = runtimeFixture({ decideError: error });
  await assert.rejects(runtime.decideApproval({
    approvalId: 'approval-a',
    executionId: 'execution-a',
    decision: 'approved',
    actorId: 'owner:Admin'
  }), e => e === error);
  assert.ok(calls.some(call => call.kind === 'requestCancellation' && call.reason === 'approval_expired'));
  assert.ok(calls.some(call => call.kind === 'expireWorkflow'));
});

test('Runtime cancellation also reconciles a waiting approval workflow', async () => {
  const { runtime, calls } = runtimeFixture();
  const result = await runtime.cancelExecution('execution-a', { reason: 'owner_cancelled' });
  assert.equal(result.executionId, 'execution-a');
  assert.ok(calls.some(call => call.kind === 'cancelWorkflow' &&
    call.executionId === 'execution-a' && call.reason === 'owner_cancelled'));
});


test('Runtime forwards authenticated owner authority through resume and approval reconciliation', async () => {
  const { runtime, calls } = runtimeFixture();
  const principal = { tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' };
  await runtime.resume('execution-a', {}, null, principal);
  assert.strictEqual(calls.find(call => call.kind === 'reconcileResume').persistencePrincipal, principal);
});

test('Runtime forwards owner authority when refreshing and expiring approval challenges', async () => {
  const principal = { tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' };
  const required = Object.assign(new Error('Approval required'), {
    code: 'APPROVAL_REQUIRED', executionContext: { approvalId: 'approval-next' }
  });
  const first = runtimeFixture({ resumeError: required });
  await assert.rejects(first.runtime.resume('execution-a', {}, null, principal), error => error === required);
  assert.strictEqual(first.calls.find(call => call.kind === 'updateChallenge').persistencePrincipal, principal);

  const expired = Object.assign(new Error('Approval expired'), {
    code: 'APPROVAL_EXPIRED', approvalId: 'approval-a'
  });
  const second = runtimeFixture({ resumeError: expired });
  await assert.rejects(second.runtime.resume('execution-a', {}, null, principal), error => error === expired);
  assert.strictEqual(second.calls.find(call => call.kind === 'findBlocked').persistencePrincipal, principal);
  assert.strictEqual(second.calls.find(call => call.kind === 'expireWorkflow').persistencePrincipal, principal);
});

test('Runtime forwards owner authority through explicit execution cancellation', async () => {
  const { runtime, calls } = runtimeFixture();
  const principal = { tenantId: 'tenant-a', ownerId: 'owner-a', sessionId: 'session-a' };
  await runtime.cancelExecution('execution-a', { reason: 'owner_cancelled', persistencePrincipal: principal });
  assert.strictEqual(calls.find(call => call.kind === 'cancelWorkflow').persistencePrincipal, principal);
});
