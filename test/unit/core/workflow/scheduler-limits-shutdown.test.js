const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const WorkflowScheduler = require('../../../../src/core/workflow/workflow-scheduler');

function instance(id, tenantId = 'tenant-a') {
  const definition = new WorkflowDefinition({
    id: 'limit.test',
    version: 1,
    name: 'Limit Test',
    steps: [{ id: 'step', agent: 'TEST' }]
  });
  return new WorkflowInstance({
    definition,
    workflowId: id,
    tenantId,
    input: { value: id }
  });
}

test('scheduler enforces bounded queue capacity', () => {
  const scheduler = new WorkflowScheduler({
    maxConcurrent: 1,
    maxQueueDepth: 1,
    tenantId: 'tenant-a'
  });

  scheduler.enqueue(instance('workflow-1'));

  assert.throws(
    () => scheduler.enqueue(instance('workflow-2')),
    (error) => error.code === 'SCHEDULER_QUEUE_FULL'
  );
});

test('scheduler shutdown stops admission and can durably cancel queued work', () => {
  const persisted = [];
  const repository = {
    save(value) {
      persisted.push(value.toJSON());
    },
    findAll() { return []; }
  };

  const scheduler = new WorkflowScheduler({
    maxConcurrent: 1,
    tenantId: 'tenant-a',
    workflowRepository: repository
  });

  const queued = instance('workflow-shutdown');
  scheduler.enqueue(queued);

  const snapshot = scheduler.shutdown({ cancelQueued: true });

  assert.equal(snapshot.queued, 0);
  assert.equal(queued.state, 'CANCELLED');
  assert.equal(persisted.at(-1).state, 'CANCELLED');

  assert.throws(
    () => scheduler.enqueue(instance('workflow-after-shutdown')),
    (error) => error.code === 'SCHEDULER_SHUTTING_DOWN'
  );
});
