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
    async findApprovalBlockedWorkflow(executionId) {
      calls.push({ kind: 'findBlocked', executionId });
      return { metadata: { approvalId: overrides.currentApprovalId || 'approval-a' } };
    },
    async reconcileApprovalResume(executionId, result) {
      calls.push({ kind: 'reconcileResume', executionId, result });
      return true;
    },
    async updateApprovalChallenge(executionId, approvalId) {
      calls.push({ kind: 'updateChallenge', executionId, approvalId });
      return true;
    },
    async expireApprovalWorkflow(executionId, approvalId) {
      calls.push({ kind: 'expireWorkflow', executionId, approvalId });
      return true;
    },
    async cancelApprovalWorkflow(executionId, reason) {
      calls.push({ kind: 'cancelWorkflow', executionId, reason });
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
