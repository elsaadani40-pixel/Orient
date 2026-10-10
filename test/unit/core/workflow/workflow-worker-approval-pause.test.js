'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowWorker = require('../../../../src/core/workflow/workflow-worker');
const { WorkflowDefinition, WorkflowInstance } = require('../../../../src/core/workflow');

test('synchronous workflow worker pauses on approval-required without retrying or failing the step', async () => {
  const definition = new WorkflowDefinition({
    id: 'approval-pause-sync-regression',
    version: 1,
    name: 'Approval pause sync regression',
    steps: [{ id: 'write', tool: 'sensitive.write' }]
  });
  const instance = new WorkflowInstance({
    definition,
    workflowId: 'approval-pause-sync-workflow',
    tenantId: 'tenant-a',
    input: { goal: 'perform guarded operation' }
  });
  instance.transition('QUEUED');
  instance.transition('RUNNING');

  const events = [];
  let retryCalls = 0;
  let executorCalls = 0;
  const scheduler = {
    lease() {
      return {
        workflowId: instance.workflowId,
        instance,
        leaseId: 'lease-sync-1',
        workerId: 'worker-sync-1',
        cancelled: false,
        previousState: 'QUEUED'
      };
    },
    renew() {},
    retry() { retryCalls += 1; return true; },
    release() {}
  };
  const worker = new WorkflowWorker({
    scheduler,
    eventSink: event => events.push(event),
    workerId: 'worker-sync-1',
    executor: async () => {
      executorCalls += 1;
      throw Object.assign(new Error('Human approval is required'), {
        code: 'APPROVAL_REQUIRED',
        executionContext: { executionId: 'execution-sync-1', approvalId: 'approval-sync-1' }
      });
    }
  });

  const result = await worker.tick();

  assert.equal(result.state, WorkflowInstance.STATES.WAITING);
  assert.equal(result.steps.write.state, WorkflowDefinition.STEP_STATES.PENDING);
  assert.equal(result.metadata.taskId, 'approval-pause-sync-workflow');
  assert.equal(result.metadata.executionId, 'execution-sync-1');
  assert.equal(result.metadata.approvalBlocked, true);
  assert.equal(result.metadata.approvalExecutionId, 'execution-sync-1');
  assert.equal(result.metadata.approvalId, 'approval-sync-1');
  assert.equal(executorCalls, 1);
  assert.equal(retryCalls, 0);
  assert.ok(events.some(event => event.type === 'workflow.approval.required'));
  assert.ok(events.some(event => event.type === 'workflow.state.changed' && event.payload.to === 'WAITING'));
});
