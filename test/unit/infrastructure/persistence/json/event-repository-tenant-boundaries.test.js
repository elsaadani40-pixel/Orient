'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventRepository = require('../../../../../src/infrastructure/persistence/json/event.repository');

function createRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-tenant-boundary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new EventRepository(path.join(directory, 'events.json'));
}

test('unscoped local aggregate events do not advance a tenant aggregate sequence', t => {
  const repository = createRepository(t);
  repository.appendMissionEvent({
    id: 'local-unscoped-event', aggregateId: 'shared-aggregate-id', sequence: 1,
    type: 'mission.local', data: {}
  });
  const tenantEvent = repository.appendMissionEvent({
    id: 'tenant-a-event', aggregateId: 'shared-aggregate-id', sequence: 1,
    type: 'mission.tenant', data: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' });
  assert.equal(tenantEvent.sequence, 1);
  assert.deepEqual(
    repository.findByAggregateId('shared-aggregate-id', { tenantId: 'tenant-a' }).map(event => event.id),
    ['tenant-a-event']
  );
});

test('local aggregate sequence includes unscoped events but excludes tenant-owned events', t => {
  const repository = createRepository(t);
  repository.appendMissionEvent({
    id: 'local-unscoped-event', aggregateId: 'shared-aggregate-id', sequence: 1,
    type: 'mission.local', data: {}
  });
  repository.appendMissionEvent({
    id: 'tenant-a-event', aggregateId: 'shared-aggregate-id', sequence: 1,
    type: 'mission.tenant', data: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' });

  const localEvent = repository.appendMissionEvent({
    id: 'local-event', aggregateId: 'shared-aggregate-id', sequence: 2,
    type: 'mission.local', data: { tenantId: 'local' }
  }, { tenantId: 'local' });

  assert.equal(localEvent.sequence, 2);
  assert.deepEqual(
    repository.findByAggregateId('shared-aggregate-id', { tenantId: 'local' }).map(event => event.id),
    ['local-unscoped-event', 'local-event']
  );
});

test('an event id owned by another tenant cannot be replayed or overwritten', t => {
  const repository = createRepository(t);
  const original = repository.appendMissionEvent({
    id: 'cross-tenant-stable-id',
    aggregateId: 'tenant-a-aggregate',
    sequence: 1,
    type: 'mission.created',
    data: { tenantId: 'tenant-a', state: 'original' }
  }, { tenantId: 'tenant-a' });

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'cross-tenant-stable-id',
      aggregateId: 'tenant-b-aggregate',
      sequence: 1,
      type: 'mission.created',
      data: { tenantId: 'tenant-b', state: 'attacker-replay' }
    }, { tenantId: 'tenant-b' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );

  assert.deepEqual(repository.findByAggregateId('tenant-a-aggregate', { tenantId: 'tenant-a' }), [original]);
  assert.deepEqual(repository.findByAggregateId('tenant-b-aggregate', { tenantId: 'tenant-b' }), []);
});

test('belongsToTenant explicitly enforces tenant and local boundaries', t => {
  const repository = createRepository(t);

  assert.equal(repository.belongsToTenant(undefined, 'tenant-a'), false);
  assert.equal(repository.belongsToTenant({}, 'tenant-a'), false);
  assert.equal(repository.belongsToTenant({ data: {} }, 'tenant-a'), false);
  assert.equal(repository.belongsToTenant({ data: { tenantId: 'tenant-b' } }, 'tenant-a'), false);
  assert.equal(repository.belongsToTenant({ data: { tenantId: 'tenant-a' } }, 'tenant-a'), true);

  assert.equal(repository.belongsToTenant({ data: {} }, 'local'), true);
  assert.equal(repository.belongsToTenant({ data: { tenantId: 'local' } }, 'local'), true);
  assert.equal(repository.belongsToTenant({ data: { tenantId: 'tenant-a' } }, 'local'), false);
});
