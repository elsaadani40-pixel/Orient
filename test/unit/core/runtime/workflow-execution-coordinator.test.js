const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowExecutionCoordinator = require('../../../../src/core/runtime/workflow-execution-coordinator');
const WorkflowScheduler = require('../../../../src/core/workflow/workflow-scheduler');

test('WorkflowExecutionCoordinator preserves runtime identity and delegates request execution', async () => {
  const scheduler = new WorkflowScheduler({
    tenantId: 'tenant-a'
  });

  const events = [];
  const persistence = {
    events: {
      append(event) {
        events.push(event);
        return event;
      }
    }
  };

  const calls = [];
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler,
    persistence,
    tenantId: 'tenant-a',
    userId: 'user-a',
    workspaceId: 'workspace-a',
    executeRequest: async (input, options) => {
      calls.push({ input, options });
      return { ok: true, input };
    }
  });

  const result = await coordinator.execute('hello', {
    approval: 'approval-1',
    approvals: { 'tool.write': 'approval-1' },
    priority: 7
  });

  assert.deepEqual(result, { ok: true, input: 'hello' });
  assert.deepEqual(calls, [{
    input: 'hello',
    options: {
      approval: 'approval-1',
      approvals: { 'tool.write': 'approval-1' }
    }
  }]);
  assert.equal(events.length > 0, true);

  const workflowEvent = events.find(event => event.executionId);
  assert.equal(workflowEvent.data.tenantId, 'tenant-a');
});

test('WorkflowExecutionCoordinator rejects empty input before scheduling', async () => {
  let scheduled = false;
  const scheduler = {
    async enqueueDurable() {
      scheduled = true;
    },
    async tick() {}
  };

  const coordinator = new WorkflowExecutionCoordinator({
    scheduler,
    tenantId: 'tenant-a',
    executeRequest: async () => ({ ok: true })
  });

  const result = await coordinator.execute('   ');
  assert.deepEqual(result, {
    type: 'error',
    message: 'لم يتم إرسال طلب.'
  });
  assert.equal(scheduled, false);
});

test('WorkflowExecutionCoordinator accepts a durable workflow without executing it inline', async () => {
  const AsyncWorkflowScheduler = require('../../../../src/core/workflow/async-workflow-scheduler');
  const saved = new Map();
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-a',
    workflowRepository: {
      async save(instance) {
        saved.set(instance.workflowId, instance.toJSON());
        return instance.toJSON();
      }
    }
  });
  let executed = false;
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler,
    workflowRepository: {
      async save(instance) {
        saved.set(instance.workflowId, instance.toJSON());
        return instance.toJSON();
      }
    },
    tenantId: 'tenant-a',
    userId: 'user-a',
    workspaceId: 'workspace-a',
    executeRequest: async () => {
      executed = true;
      return { ok: true };
    }
  });

  const accepted = await coordinator.enqueue('prepare the report', {
    workflowId: 'workflow-accepted-1',
    priority: 3
  });

  assert.deepEqual(accepted, {
    workflowId: 'workflow-accepted-1',
    state: 'QUEUED',
    tenantId: 'tenant-a',
    createdAt: accepted.createdAt,
    updatedAt: accepted.updatedAt
  });
  assert.equal(typeof accepted.createdAt, 'string');
  assert.equal(typeof accepted.updatedAt, 'string');
  assert.equal(executed, false);
  assert.equal(scheduler.depth(), 1);
  assert.equal(saved.get('workflow-accepted-1').state, 'QUEUED');
});

test('WorkflowExecutionCoordinator rejects durable acceptance with a synchronous scheduler', async () => {
  const scheduler = new WorkflowScheduler({ tenantId: 'tenant-a' });
  const coordinator = new WorkflowExecutionCoordinator({
    scheduler,
    tenantId: 'tenant-a',
    executeRequest: async () => ({ ok: true })
  });

  await assert.rejects(
    () => coordinator.enqueue('prepare the report'),
    error => error?.code === 'ASYNC_WORKFLOW_SCHEDULER_REQUIRED'
  );
});
