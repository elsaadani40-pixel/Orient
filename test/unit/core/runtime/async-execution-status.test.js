const test = require('node:test');
const assert = require('node:assert/strict');
const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');
const createAgentRoutes = require('../../../../src/interfaces/http/routes/agent.routes');

function runtimeWithAsyncExecutionRead(execution) {
  const runtime = Object.create(OrientRuntime.prototype);
  runtime.tenantId = 'tenant-a';
  runtime.persistence = {
    executions: {
      async findById(executionId, options) {
        assert.equal(executionId, 'exec-1');
        assert.deepEqual(options, { tenantId: 'tenant-a' });
        return execution;
      }
    }
  };
  return runtime;
}

test('execution status awaits asynchronous persistence and returns the stored status', async () => {
  const execution = {
    executionId: 'exec-1',
    requestId: 'req-1',
    goalId: 'goal-1',
    metadata: { tenantId: 'tenant-a' },
    status: 'completed',
    cancellationRequested: false,
    agentLifecycle: 'completed',
    currentStep: 1,
    result: { ok: true }
  };
  const runtime = runtimeWithAsyncExecutionRead(execution);

  assert.deepEqual(await runtime.getExecutionStatus('exec-1'), {
    executionId: 'exec-1',
    requestId: 'req-1',
    goalId: 'goal-1',
    tenantId: 'tenant-a',
    status: 'completed',
    cancellationRequested: false,
    cancellationReason: null,
    agentLifecycle: 'completed',
    currentStep: 1,
    startedAt: undefined,
    completedAt: undefined,
    updatedAt: undefined,
    result: { ok: true }
  });
});

test('execution status rejects an asynchronously missing execution', async () => {
  const runtime = runtimeWithAsyncExecutionRead(null);
  await assert.rejects(
    () => runtime.getExecutionStatus('exec-1'),
    error => error.code === 'EXECUTION_NOT_FOUND'
  );
});

test('execution approvals await the asynchronous existence check', async () => {
  const runtime = runtimeWithAsyncExecutionRead(null);
  runtime.approvalService = {
    async listForExecution() {
      assert.fail('approval listing must not run for a missing execution');
    }
  };
  await assert.rejects(
    () => runtime.getExecutionApprovals('exec-1'),
    error => error.code === 'EXECUTION_NOT_FOUND'
  );
});

test('HTTP execution status route awaits the service result before serialization', async () => {
  const routes = createAgentRoutes({
    async getExecutionStatus(executionId) {
      assert.equal(executionId, 'exec-1');
      return { executionId, status: 'completed' };
    }
  });
  let body = '';
  const response = {
    writeHead(status, headers) {
      assert.equal(status, 200);
      assert.match(headers['Content-Type'], /application\\/json/);
    },
    end(value) { body = value; }
  };

  await routes.status({}, response, 'exec-1');
  assert.deepEqual(JSON.parse(body), { executionId: 'exec-1', status: 'completed' });
});
