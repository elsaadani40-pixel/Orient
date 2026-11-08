'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExecutionPersistenceCoordinator = require('../../../../src/core/runtime/execution-persistence-coordinator');
const { createPersistencePrincipal } = require('../../../../src/core/security/persistence-principal');

function principal(ownerId) {
  return createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId,
    sessionId: 'session-' + ownerId
  });
}

function context(executionId, ownerId) {
  return {
    events: [{ id: 'event-' + executionId, executionId, type: 'execution.started', data: {} }],
    snapshot() {
      return {
        executionId,
        tenantId: 'tenant-a',
        userId: ownerId,
        status: 'running',
        events: this.events
      };
    }
  };
}

test('execution persistence coordinator passes immutable principal per operation without singleton state', async () => {
  const calls = [];
  const persistence = {
    executions: {
      async insert(snapshot, options) {
        calls.push({ method: 'insert', owner: snapshot.userId, principal: options.persistencePrincipal });
        return snapshot;
      },
      async update(executionId, snapshot, options) {
        calls.push({ method: 'update', owner: snapshot.userId, principal: options.persistencePrincipal });
        return snapshot;
      }
    },
    events: {
      async appendMany(events, options) {
        calls.push({ method: 'events', owner: options.persistencePrincipal.ownerId, principal: options.persistencePrincipal });
        return events;
      }
    },
    checkpoints: {
      async save(snapshot, options) {
        calls.push({ method: 'checkpoint', owner: snapshot.userId, principal: options.persistencePrincipal });
        return { executionId: snapshot.executionId };
      }
    }
  };
  const coordinator = new ExecutionPersistenceCoordinator({ persistence, tenantId: 'tenant-a' });
  const ownerA = principal('owner-a');
  const ownerB = principal('owner-b');

  await coordinator.checkpoint(context('exec-a', 'owner-a'), 'insert', 'initial', ownerA);
  await coordinator.checkpoint(context('exec-b', 'owner-b'), 'insert', 'initial', ownerB);

  assert.deepEqual(calls.map(call => [call.method, call.owner]), [
    ['insert', 'owner-a'], ['events', 'owner-a'], ['checkpoint', 'owner-a'],
    ['insert', 'owner-b'], ['events', 'owner-b'], ['checkpoint', 'owner-b']
  ]);
  assert.ok(calls.every(call => call.principal === ownerA || call.principal === ownerB));
  assert.equal(calls[0].principal, ownerA);
  assert.equal(calls[3].principal, ownerB);
});
