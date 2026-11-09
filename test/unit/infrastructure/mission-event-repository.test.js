const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventRepository = require('../../../src/infrastructure/persistence/json/event.repository');

test('mission events receive durable per-aggregate sequence under the repository lock', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-events-'));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  const first = repository.appendMissionEvent({
    id: 'm1',
    aggregateId: 'wf-1',
    type: 'workflow.created',
    data: {}
  });
  const second = repository.appendMissionEvent({
    id: 'm2',
    aggregateId: 'wf-1',
    type: 'workflow.state.changed',
    data: { to: 'QUEUED' }
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(repository.findByAggregateId('wf-1').map(event => event.sequence), [1, 2]);

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'm3',
      aggregateId: 'wf-1',
      sequence: 9,
      type: 'workflow.state.changed',
      data: { to: 'RUNNING' }
    }),
    error => error.code === 'MISSION_EVENT_SEQUENCE_CONFLICT'
  );

  fs.rmSync(directory, { recursive: true, force: true });
});


test('mission event replay is idempotent but rejects stable ID reuse with changed content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-event-idempotency-'));
  const repository = new EventRepository(path.join(directory, 'events.json'));
  try {
    const original = {
      id: 'stable-event-id',
      aggregateId: 'wf-stable',
      type: 'workflow.state.changed',
      data: { tenantId: 'tenant-a', to: 'QUEUED' }
    };
    const first = repository.appendMissionEvent(original, { tenantId: 'tenant-a' });
    const replay = repository.appendMissionEvent(original, { tenantId: 'tenant-a' });
    assert.equal(replay.sequence, first.sequence);
    assert.equal(replay.timestamp, first.timestamp);
    assert.throws(
      () => repository.appendMissionEvent({
        ...original, data: { tenantId: 'tenant-a', to: 'FAILED' }
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'MISSION_EVENT_ID_CONFLICT'
    );
    assert.throws(
      () => repository.appendMissionEvent({
        ...original, aggregateId: 'wf-other'
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'MISSION_EVENT_ID_CONFLICT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('JSON mission-event repository rejects worker writes without durable worker fencing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-event-fencing-'));
  const repository = new EventRepository(path.join(directory, 'events.json'));
  try {
    assert.throws(
      () => repository.appendMissionEvent({
        id: 'worker-event-1', aggregateId: 'workflow-1',
        type: 'workflow.step.completed', data: { tenantId: 'tenant-a' }
      }, {
        tenantId: 'tenant-a',
        workerPrincipal: { tenantId: 'tenant-a', workerId: 'worker-a', sessionId: 'session-a', workflowId: 'workflow-1', leaseId: 'lease-a', fencingToken: 1 }
      }),
      error => error.code === 'WORKER_DURABLE_FENCING_UNSUPPORTED' && error.status === 503
    );
    assert.deepEqual(repository.findByAggregateId('workflow-1', { tenantId: 'tenant-a' }), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
