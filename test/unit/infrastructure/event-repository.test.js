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


test('append rejects event-id collisions owned by another tenant', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-append-tenant-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.append({
    id: 'shared-append-id',
    type: 'tenant-a.event',
    data: {}
  }, { tenantId: 'tenant-a' });

  assert.throws(
    () => repository.append({
      id: 'shared-append-id',
      type: 'tenant-b.event',
      data: {}
    }, { tenantId: 'tenant-b' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.equal(repository.findAll({ tenantId: 'tenant-a' })[0].type, 'tenant-a.event');
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-b' }), []);
});

test('appendMany rejects event-id collisions owned by another tenant atomically', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-append-many-tenant-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMany([{
    id: 'shared-batch-id',
    type: 'tenant-a.event',
    data: {}
  }], { tenantId: 'tenant-a' });

  assert.throws(
    () => repository.appendMany([
      { id: 'tenant-b-new-id', type: 'tenant-b.new', data: {} },
      { id: 'shared-batch-id', type: 'tenant-b.collision', data: {} }
    ], { tenantId: 'tenant-b' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-b' }), []);
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-a' }).map(event => event.type), ['tenant-a.event']);
});

test('appendMany rejects duplicate ids crossing tenants within one batch', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-batch-collision-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.throws(
    () => repository.appendMany([
      { id: 'same-batch-id', type: 'tenant-a.event', data: { tenantId: 'tenant-a' } },
      { id: 'same-batch-id', type: 'tenant-b.event', data: { tenantId: 'tenant-b' } }
    ]),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.equal(repository.count(), 0);
});


test('append reports a stable tenant mismatch code for caller-supplied tenant metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-append-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.throws(
    () => repository.append({
      id: 'mismatched-append',
      type: 'tenant-b.event',
      data: { tenantId: 'tenant-b' }
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.equal(repository.count(), 0);
});

test('appendMany reports a stable tenant mismatch code before writing any event', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-many-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.throws(
    () => repository.appendMany([
      { id: 'valid-event', type: 'tenant-a.event', data: {} },
      { id: 'mismatched-event', type: 'tenant-b.event', data: { tenantId: 'tenant-b' } }
    ], { tenantId: 'tenant-a' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.equal(repository.count(), 0);
});
