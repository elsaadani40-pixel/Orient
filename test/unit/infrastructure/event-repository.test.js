const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EventRepository =
  require('../../../src/infrastructure/persistence/json/event.repository');

test('event persistence is replay-safe by event id', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-events-')
  );

  const repository =
    new EventRepository(
      path.join(directory, 'events.json')
    );

  const event = {
    id: 'event-1',
    executionId: 'exec-1',
    type: 'checkpoint.saved',
    timestamp: new Date().toISOString(),
    data: { step: 1 }
  };

  assert.equal(
    repository.appendMany([event, event]).length,
    1
  );

  assert.equal(
    repository.appendMany([event]).length,
    0
  );

  assert.equal(
    repository.count(),
    1
  );

  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
});


test('mission event sequence is isolated by tenant for a shared aggregate id', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-tenants-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  const tenantA = repository.appendMissionEvent({
    id: 'tenant-a-event-1',
    aggregateId: 'shared-mission',
    type: 'mission.started',
    data: {}
  }, { tenantId: 'tenant-a' });
  const tenantB = repository.appendMissionEvent({
    id: 'tenant-b-event-1',
    aggregateId: 'shared-mission',
    type: 'mission.started',
    data: {}
  }, { tenantId: 'tenant-b' });

  assert.equal(tenantA.sequence, 1);
  assert.equal(tenantB.sequence, 1);
  assert.deepEqual(repository.findByAggregateId('shared-mission', { tenantId: 'tenant-a' }).map(event => event.id), ['tenant-a-event-1']);
  assert.deepEqual(repository.findByAggregateId('shared-mission', { tenantId: 'tenant-b' }).map(event => event.id), ['tenant-b-event-1']);
});

test('mission event idempotency never returns another tenant event', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-id-collision-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMissionEvent({
    id: 'shared-event-id',
    aggregateId: 'tenant-a-mission',
    type: 'tenant-a.secret',
    data: {}
  }, { tenantId: 'tenant-a' });

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'shared-event-id',
      aggregateId: 'tenant-b-mission',
      type: 'tenant-b.event',
      data: {}
    }, { tenantId: 'tenant-b' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.deepEqual(repository.findByAggregateId('tenant-b-mission', { tenantId: 'tenant-b' }), []);
  assert.equal(repository.findByAggregateId('tenant-a-mission', { tenantId: 'tenant-a' })[0].type, 'tenant-a.secret');
});
