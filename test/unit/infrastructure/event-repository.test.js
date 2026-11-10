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

test('tenant-scoped lookups never expose unscoped or local events to another tenant', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-local-tenant-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMissionEvent({ id: 'unscoped-1', aggregateId: 'shared-aggregate', type: 'mission.updated', data: {} });
  repository.appendMissionEvent({ id: 'local-1', aggregateId: 'shared-aggregate', type: 'mission.updated', data: { tenantId: 'local' } });
  repository.appendMissionEvent({ id: 'tenant-a-1', aggregateId: 'shared-aggregate', type: 'mission.updated', data: { tenantId: 'tenant-a' } });
  repository.appendMissionEvent({ id: 'tenant-a-2', aggregateId: 'shared-aggregate', type: 'mission.updated', data: { tenantId: 'tenant-a' } });

  assert.deepEqual(repository.findAll({ tenantId: 'tenant-a' }).map(event => event.id), ['tenant-a-1', 'tenant-a-2']);
  assert.deepEqual(repository.findAll({ tenantId: 'local' }).map(event => event.id), ['unscoped-1', 'local-1']);
  assert.deepEqual(repository.findByType('mission.updated', { tenantId: 'tenant-a' }).map(event => event.id), ['tenant-a-1', 'tenant-a-2']);
  assert.deepEqual(repository.findByAggregateId('shared-aggregate', { tenantId: 'tenant-a' }).map(event => event.sequence), [1, 2]);
  assert.deepEqual(repository.findByAggregateId('shared-aggregate', { tenantId: 'local' }).map(event => event.sequence), [1, 2]);
});

test('mission event writes preserve the tenant mismatch error contract', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-mission-tenant-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.throws(
    () => repository.appendMissionEvent({ id: 'mismatch', aggregateId: 'aggregate', type: 'mission.updated', data: { tenantId: 'tenant-b' } }, { tenantId: 'tenant-a' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
});

test('execution, goal, type and aggregate lookups never cross tenant boundaries', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-query-tenant-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));
  repository.appendMany([
    { id: 'a-event', type: 'mission.updated', executionId: 'shared-execution', goalId: 'shared-goal', aggregateId: 'shared-aggregate', sequence: 1, data: { tenantId: 'tenant-a' } },
    { id: 'b-event', type: 'mission.updated', executionId: 'shared-execution', goalId: 'shared-goal', aggregateId: 'shared-aggregate', sequence: 1, data: { tenantId: 'tenant-b' } }
  ]);
  const onlyA = { tenantId: 'tenant-a' };
  assert.deepEqual(repository.findByExecutionId('shared-execution', onlyA).map(event => event.id), ['a-event']);
  assert.deepEqual(repository.findByGoalId('shared-goal', onlyA).map(event => event.id), ['a-event']);
  assert.deepEqual(repository.findByType('mission.updated', onlyA).map(event => event.id), ['a-event']);
  assert.deepEqual(repository.findByAggregateId('shared-aggregate', onlyA).map(event => event.id), ['a-event']);
});

test('mission event sequencing derives tenant scope from metadata when option is omitted', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-tenant-metadata-scope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMissionEvent({ id: 'a-1', aggregateId: 'shared-aggregate', type: 'mission.started', data: { tenantId: 'tenant-a' } });
  repository.appendMissionEvent({ id: 'b-1', aggregateId: 'shared-aggregate', type: 'mission.started', data: { tenantId: 'tenant-b' } });
  repository.appendMissionEvent({ id: 'b-2', aggregateId: 'shared-aggregate', type: 'mission.progressed', data: { tenantId: 'tenant-b' } });

  const tenantASecond = repository.appendMissionEvent({ id: 'a-2', aggregateId: 'shared-aggregate', sequence: 2, type: 'mission.progressed', data: { tenantId: 'tenant-a' } });
  assert.equal(tenantASecond.sequence, 2);
  assert.deepEqual(repository.findByAggregateId('shared-aggregate', { tenantId: 'tenant-a' }).map(event => event.sequence), [1, 2]);
  assert.deepEqual(repository.findByAggregateId('shared-aggregate', { tenantId: 'tenant-b' }).map(event => event.sequence), [1, 2]);
});

test('findByType never returns another tenant events for a shared event type', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-type-tenant-filter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMany([
    { id: 'tenant-a-event', type: 'mission.updated', data: { tenantId: 'tenant-a' } },
    { id: 'tenant-b-event', type: 'mission.updated', data: { tenantId: 'tenant-b' } }
  ]);

  assert.deepEqual(
    repository.findByType('mission.updated', { tenantId: 'tenant-a' }).map(event => event.id),
    ['tenant-a-event']
  );
  assert.deepEqual(
    repository.findByType('mission.updated', { tenantId: 'tenant-b' }).map(event => event.id),
    ['tenant-b-event']
  );
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

test('append rejects cross-tenant event-id reuse using embedded tenant metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-append-metadata-replay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.append({
    id: 'metadata-owned-id',
    type: 'tenant-a.event',
    data: { tenantId: 'tenant-a' }
  });

  assert.throws(
    () => repository.append({
      id: 'metadata-owned-id',
      type: 'tenant-b.event',
      data: { tenantId: 'tenant-b' }
    }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-a' }).map(event => event.type), ['tenant-a.event']);
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-b' }), []);
});

test('append and appendMany accept matching embedded and explicit tenant identities', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-metadata-match-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.equal(repository.append({
    id: 'matching-append-id',
    type: 'tenant-a.append',
    data: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' }).id, 'matching-append-id');

  assert.deepEqual(repository.appendMany([{
    id: 'matching-batch-id',
    type: 'tenant-a.batch',
    data: { tenantId: 'tenant-a' }
  }], { tenantId: 'tenant-a' }).map(event => event.id), ['matching-batch-id']);
});

test('appendMany rejects cross-tenant event-id reuse when tenant scope comes from metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-batch-metadata-replay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMany([{
    id: 'metadata-batch-owned-id',
    type: 'tenant-a.event',
    data: { tenantId: 'tenant-a' }
  }]);

  assert.throws(
    () => repository.appendMany([{
      id: 'metadata-batch-owned-id',
      type: 'tenant-b.event',
      data: { tenantId: 'tenant-b' }
    }]),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-a' }).map(event => event.type), ['tenant-a.event']);
  assert.deepEqual(repository.findAll({ tenantId: 'tenant-b' }), []);
});

test('mission event sequencing is isolated by aggregate and advances from the maximum sequence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-aggregate-sequence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  const first = repository.appendMissionEvent({
    id: 'aggregate-a-1', aggregateId: 'aggregate-a', sequence: 1,
    type: 'mission.started', data: { tenantId: 'tenant-a' }
  });
  const independent = repository.appendMissionEvent({
    id: 'aggregate-b-1', aggregateId: 'aggregate-b', sequence: 1,
    type: 'mission.started', data: { tenantId: 'tenant-a' }
  });
  const second = repository.appendMissionEvent({
    id: 'aggregate-a-2', aggregateId: 'aggregate-a', sequence: 2,
    type: 'mission.progressed', data: { tenantId: 'tenant-a' }
  });
  const third = repository.appendMissionEvent({
    id: 'aggregate-a-3', aggregateId: 'aggregate-a', sequence: 3,
    type: 'mission.completed', data: { tenantId: 'tenant-a' }
  });

  assert.deepEqual([first.sequence, independent.sequence, second.sequence, third.sequence], [1, 1, 2, 3]);
});

test('findByAggregateId filters the requested aggregate and sorts by sequence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-aggregate-query-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.write([
    { id: 'aggregate-a-2', aggregateId: 'aggregate-a', sequence: 2, type: 'mission.progressed', data: { tenantId: 'tenant-a' } },
    { id: 'aggregate-b-1', aggregateId: 'aggregate-b', sequence: 1, type: 'mission.started', data: { tenantId: 'tenant-a' } },
    { id: 'aggregate-a-1', aggregateId: 'aggregate-a', sequence: 1, type: 'mission.started', data: { tenantId: 'tenant-a' } }
  ]);

  assert.deepEqual(
    repository.findByAggregateId('aggregate-a', { tenantId: 'tenant-a' }).map(event => event.id),
    ['aggregate-a-1', 'aggregate-a-2']
  );
});

test('mission event idempotency compares each immutable identity field independently', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-identity-fields-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));
  const original = {
    id: 'immutable-mission-event',
    aggregateId: 'aggregate-a',
    sequence: 1,
    type: 'mission.started',
    executionId: 'execution-a',
    goalId: 'goal-a',
    timestamp: '2026-11-10T12:00:00.000Z',
    data: { tenantId: 'tenant-a', state: 'started' }
  };

  const stored = repository.appendMissionEvent(original, { tenantId: 'tenant-a' });
  assert.deepEqual(repository.appendMissionEvent(original, { tenantId: 'tenant-a' }), stored);

  const conflictingVariants = [
    { ...original, aggregateId: 'aggregate-b' },
    { ...original, type: 'mission.completed' },
    { ...original, executionId: 'execution-b' },
    { ...original, goalId: 'goal-b' },
    { ...original, timestamp: '2026-11-10T12:00:01.000Z' },
    { ...original, sequence: 2 },
    { ...original, data: { tenantId: 'tenant-a', state: 'changed' } }
  ];

  for (const variant of conflictingVariants) {
    assert.throws(
      () => repository.appendMissionEvent(variant, { tenantId: 'tenant-a' }),
      error => error.code === 'MISSION_EVENT_ID_CONFLICT'
    );
  }
  assert.deepEqual(repository.findByAggregateId('aggregate-a', { tenantId: 'tenant-a' }), [stored]);
});

test('an empty timestamp remains unspecified for mission event idempotency', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-empty-timestamp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));
  const event = {
    id: 'empty-timestamp-event',
    aggregateId: 'aggregate-empty-timestamp',
    type: 'mission.started',
    timestamp: '',
    data: { tenantId: 'tenant-a' }
  };

  const stored = repository.appendMissionEvent(event);
  assert.deepEqual(repository.appendMissionEvent(event), stored);
});

test('event query helpers preserve tenant boundaries for execution, goal, and type lookups', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-query-tenants-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.append({
    id: 'tenant-a-query',
    executionId: 'shared-execution',
    goalId: 'shared-goal',
    type: 'shared.type',
    data: {}
  }, { tenantId: 'tenant-a' });
  repository.append({
    id: 'tenant-b-query',
    executionId: 'shared-execution',
    goalId: 'shared-goal',
    type: 'shared.type',
    data: {}
  }, { tenantId: 'tenant-b' });

  assert.deepEqual(
    repository.findByExecutionId('shared-execution', { tenantId: 'tenant-a' }).map(event => event.id),
    ['tenant-a-query']
  );
  assert.deepEqual(
    repository.findByExecutionId('shared-execution', { tenantId: 'tenant-b' }).map(event => event.id),
    ['tenant-b-query']
  );
  assert.deepEqual(
    repository.findByGoalId('shared-goal', { tenantId: 'tenant-a' }).map(event => event.id),
    ['tenant-a-query']
  );
  assert.deepEqual(
    repository.findByGoalId('shared-goal', { tenantId: 'tenant-b' }).map(event => event.id),
    ['tenant-b-query']
  );
  assert.deepEqual(
    repository.findByType('shared.type', { tenantId: 'tenant-a' }).map(event => event.id),
    ['tenant-a-query']
  );
  assert.deepEqual(
    repository.findByType('shared.type', { tenantId: 'tenant-b' }).map(event => event.id),
    ['tenant-b-query']
  );
  assert.deepEqual(repository.findByExecutionId('', { tenantId: 'tenant-a' }), []);
  assert.deepEqual(repository.findByGoalId(null, { tenantId: 'tenant-a' }), []);
  assert.deepEqual(repository.findByType('', { tenantId: 'tenant-a' }), []);
});

test('event repository validates lock timeout and treats blank storage as empty', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-storage-boundaries-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.json');

  assert.throws(() => new EventRepository(file, { lockTimeoutMs: 0 }), TypeError);
  assert.throws(() => new EventRepository(file, { lockTimeoutMs: 1.5 }), TypeError);

  const repository = new EventRepository(file);
  fs.writeFileSync(file, '  \n\t');
  assert.deepEqual(repository.read(), []);
  fs.writeFileSync(file, '{}');
  assert.throws(() => repository.read(), error => error.code === 'EVENT_STORAGE_CORRUPT' && /root must be an array/.test(error.message));
});

test('event repository never reclaims a lock with malformed or unverifiable owner metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-unverifiable-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 12 });

  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), '{invalid-json');
  assert.throws(
    () => repository.withLock(() => 'must-not-run'),
    error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
  );
  assert.equal(fs.existsSync(repository.lockPath), true);

  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
    token: 'foreign-host-owner',
    pid: process.pid,
    hostname: 'different-host',
    acquiredAt: new Date(0).toISOString()
  }));
  let killCalls = 0;
  const originalKill = process.kill;
  try {
    process.kill = function (...args) {
      killCalls += 1;
      return originalKill.apply(process, args);
    };
    assert.throws(
      () => repository.withLock(() => 'must-not-run'),
      error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(killCalls, 0, 'a foreign-host PID must never be probed locally');
    assert.equal(fs.existsSync(repository.lockPath), true);
  } finally {
    process.kill = originalKill;
  }
});

test('event repository preserves a lock when process liveness cannot be determined', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-eperm-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 12 });
  const ownerPid = 2147483646;
  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
    token: 'permission-denied-owner',
    pid: ownerPid,
    hostname: os.hostname(),
    acquiredAt: new Date(0).toISOString()
  }));
  const originalKill = process.kill;
  try {
    process.kill = function (pid, signal) {
      if (pid === ownerPid && signal === 0) {
        throw Object.assign(new Error('permission denied while probing owner'), { code: 'EPERM' });
      }
      return originalKill.call(process, pid, signal);
    };
    assert.throws(
      () => repository.withLock(() => 'must-not-run'),
      error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(fs.existsSync(repository.lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repository.lockPath, 'owner.json'), 'utf8')).token, 'permission-denied-owner');
  } finally {
    process.kill = originalKill;
  }
});

test('mission event sequence conflicts fail without appending or advancing the aggregate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-sequence-conflict-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  repository.appendMissionEvent({
    id: 'mission-sequence-1',
    aggregateId: 'mission-sequence',
    sequence: 1,
    type: 'mission.started',
    data: {}
  }, { tenantId: 'tenant-a' });

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'mission-sequence-3',
      aggregateId: 'mission-sequence',
      sequence: 3,
      type: 'mission.progressed',
      data: {}
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'MISSION_EVENT_SEQUENCE_CONFLICT'
  );
  assert.deepEqual(repository.findByAggregateId('mission-sequence', { tenantId: 'tenant-a' }).map(event => event.sequence), [1]);

  const second = repository.appendMissionEvent({
    id: 'mission-sequence-2',
    aggregateId: 'mission-sequence',
    sequence: 2,
    type: 'mission.progressed',
    data: {}
  }, { tenantId: 'tenant-a' });
  assert.equal(second.sequence, 2);
  assert.deepEqual(repository.findByAggregateId('mission-sequence', { tenantId: 'tenant-a' }).map(event => event.sequence), [1, 2]);
});

test('event repository rejects malformed append inputs before writing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-invalid-input-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.throws(() => repository.append(null), TypeError);
  assert.throws(() => repository.appendMany({},), TypeError);
  assert.throws(() => repository.appendMany([{ id: 'valid-before-invalid', type: 'ok' }, null]), TypeError);
  assert.equal(repository.count(), 0);
});

test('mission event append rejects caller-supplied tenant metadata that conflicts with its tenant scope', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-mission-tenant-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'mission-tenant-mismatch',
      aggregateId: 'mission-tenant-mismatch',
      type: 'tenant-b.secret',
      data: { tenantId: 'tenant-b' }
    }, { tenantId: 'tenant-a' }),
    error => error.code === 'EVENT_TENANT_MISMATCH'
  );
  assert.deepEqual(repository.findByAggregateId('mission-tenant-mismatch', { tenantId: 'tenant-a' }), []);
  assert.deepEqual(repository.findByAggregateId('mission-tenant-mismatch', { tenantId: 'tenant-b' }), []);
});

test('event repository accepts the minimum positive integer lock timeout', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-min-lock-timeout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 1 });
  assert.equal(repository.lockTimeoutMs, 1);
  assert.equal(repository.withLock(() => 'acquired'), 'acquired');
});

test('event repository lock deadline waits until the configured timeout instead of expiring immediately', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-lock-deadline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 3 });
  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
    token: 'foreign-owner',
    pid: process.pid,
    hostname: 'another-host',
    acquiredAt: new Date(0).toISOString()
  }));
  const originalNow = Date.now;
  const originalWait = Atomics.wait;
  let waits = 0;
  let now = 1000;
  try {
    Date.now = () => ++now;
    Atomics.wait = () => { waits += 1; };
    assert.throws(
      () => repository.withLock(() => 'must-not-run'),
      error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(waits, 2, 'the positive timeout must permit waiting before the deadline');
  } finally {
    Date.now = originalNow;
    Atomics.wait = originalWait;
  }
});

test('event repository never probes PID zero when evaluating a lock owner', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-pid-zero-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 5 });
  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
    token: 'zero-pid-owner',
    pid: 0,
    hostname: os.hostname(),
    acquiredAt: new Date(0).toISOString()
  }));
  const originalKill = process.kill;
  let calls = 0;
  try {
    process.kill = () => { calls += 1; throw new Error('PID zero must not be probed'); };
    assert.throws(
      () => repository.withLock(() => 'must-not-run'),
      error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(calls, 0);
  } finally {
    process.kill = originalKill;
  }
});
