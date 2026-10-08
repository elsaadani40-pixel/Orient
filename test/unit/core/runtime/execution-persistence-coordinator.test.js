const test = require('node:test');
const assert = require('node:assert/strict');
const ExecutionPersistenceCoordinator = require('../../../../src/core/runtime/execution-persistence-coordinator');

test('checkpoint does not advance event offset when durable event append fails', async () => {
  const calls = [];
  let appendAttempts = 0;
  const context = {
    tenantId: 'tenant-a',
    events: [{ id: 'event-1', type: 'test', data: { value: 1 } }],
    snapshot() {
      return {
        executionId: 'exec-1',
        tenantId: this.tenantId,
        events: this.events
      };
    }
  };

  const coordinator = new ExecutionPersistenceCoordinator({
    tenantId: 'tenant-a',
    persistence: {
      executions: {
        async update() {
          return context.snapshot();
        }
      },
      events: {
        async appendMany(events) {
          appendAttempts += 1;
          calls.push(events.map(event => event.id));
          if (appendAttempts === 1) {
            throw Object.assign(new Error('event store unavailable'), {
              code: 'PERSISTENCE_FAILURE'
            });
          }
          return events;
        }
      },
      checkpoints: {
        async save(snapshot) {
          return snapshot;
        }
      }
    }
  });

  await assert.rejects(
    coordinator.checkpoint(context),
    error => error.code === 'PERSISTENCE_FAILURE'
  );

  await coordinator.checkpoint(context);

  assert.equal(appendAttempts, 2);
  assert.deepEqual(calls, [['event-1'], ['event-1']]);
});
