const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowWorker = require('../../../../src/core/workflow/async-workflow-worker');
const { WorkflowDefinition, WorkflowInstance } = require('../../../../src/core/workflow');

test('approval-required pauses a workflow durably without retrying or failing the step', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-pause-regression',
    version: 1,
    name: 'Approval pause regression',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({
    definition,
    workflowId: 'approval-pause-workflow',
    tenantId: 'tenant-a',
    input: { goal: 'perform guarded operation' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');

  const events = [];
  const persisted = [];
  let retryCalls = 0;
  let executorCalls = 0;
  const scheduler = {
    tenantId: 'tenant-a',
    leaseDurationMs: 5000,
    async leaseAsync() {
      return {
        workflowId: instance.workflowId,
        instance,
        leaseId: 'lease-1',
        workerId: 'worker-1',
        fencingToken: 1,
        previousState: 'QUEUED',
        cancelled: false
      };
    },
    async renewAsync() {},
    async persistAsync(value) { persisted.push(value.toJSON()); },
    async releaseAsync() {},
    async assertCurrentAsync() {},
    async retryAsync() { retryCalls += 1; return true; }
  };
  const worker = new AsyncWorkflowWorker({
    scheduler,
    eventSink: event => events.push(event),
    workerId: 'worker-1',
    executor: async () => {
      executorCalls += 1;
      throw Object.assign(new Error('Human approval is required'), {
        code: 'APPROVAL_REQUIRED',
        executionContext: { executionId: 'execution-1', approvalId: 'approval-1' }
      });
    }
  });

  const result = await worker.tick();

  assert.equal(result.state, 'WAITING');
  assert.equal(result.steps.write.state, 'PENDING');
  assert.equal(result.metadata.approvalBlocked, true);
  assert.equal(result.metadata.approvalExecutionId, 'execution-1');
  assert.equal(result.metadata.approvalId, 'approval-1');
  assert.equal(executorCalls, 1);
  assert.equal(retryCalls, 0);
  assert.equal(persisted.length, 1);
  assert.ok(events.some(event => event.type === 'workflow.approval.required'));
  assert.ok(events.some(event => event.type === 'workflow.state.changed' && event.payload.to === 'WAITING'));
});
