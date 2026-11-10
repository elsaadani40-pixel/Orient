'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventRepository = require('../../../../src/infrastructure/persistence/json/event.repository');

function createRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-tenant-boundary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new EventRepository(path.join(directory, 'events.json'));
}

test('unscoped local aggregate events do not advance a tenant aggregate sequence', t => {
  const repository = createRepository(t);

  repository.appendMissionEvent({
    id: 'local-unscoped-event',
    aggregateId: 'shared-aggregate-id',
    sequence: 1,
    type: 'mission.local',
    data: {}
  });

  const tenantEvent = repository.appendMissionEvent({
    id: 'tenant-a-event',
    aggregateId: 'shared-aggregate-id',
    sequence: 1,
    type: 'mission.tenant',
    data: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' });

  assert.equal(tenantEvent.sequence, 1);
  assert.deepEqual(
    repository.findByAggregateId('shared-aggregate-id', { tenantId: 'tenant-a' }).map(event => event.id),
    ['tenant-a-event']
  );
});

test('tenant-owned aggregate events do not advance the local aggregate sequence', t => {
  const repository = createRepository(t);

  repository.appendMissionEvent({
    id: 'tenant-a-event',
    aggregateId: 'shared-aggregate-id',
    sequence: 1,
    type: 'mission.tenant',
    data: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' });

  const localEvent = repository.appendMissionEvent({
    id: 'local-event',
    aggregateId: 'shared-aggregate-id',
    sequence: 1,
    type: 'mission.local',
    data: { tenantId: 'local' }
  }, { tenantId: 'local' });

  assert.equal(localEvent.sequence, 1);
  assert.deepEqual(
    repository.findByAggregateId('shared-aggregate-id', { tenantId: 'local' }).map(event => event.id),
    ['local-event']
  );
});
