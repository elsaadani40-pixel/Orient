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
