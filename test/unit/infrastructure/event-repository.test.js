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

test('event repository reclaims a stale lock only after confirming the recorded owner is gone', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-stale-lock-'));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 100 });
  const stalePid = 2147483647;
  const originalKill = process.kill;
  try {
    fs.mkdirSync(repository.lockPath);
    fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
      token: 'stale-owner-token',
      pid: stalePid,
      hostname: os.hostname(),
      acquiredAt: new Date(0).toISOString()
    }));

    process.kill = function (pid, signal) {
      if (pid === stalePid && signal === 0) {
        throw Object.assign(new Error('simulated process is gone'), { code: 'ESRCH' });
      }
      return originalKill.call(process, pid, signal);
    };

    assert.equal(repository.withLock(() => 'acquired-after-stale-recovery'), 'acquired-after-stale-recovery');
    assert.equal(fs.existsSync(repository.lockPath), false);
    assert.deepEqual(
      fs.readdirSync(directory).filter(name => name.includes('.stale.')),
      []
    );
  } finally {
    process.kill = originalKill;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('event repository preserves a replacement lock when stale-owner observation races with replacement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-lock-replacement-'));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 50 });
  const stalePid = 2147483647;
  const originalKill = process.kill;
  let replaced = false;
  const replacementOwner = {
    token: 'replacement-owner-token',
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString()
  };

  try {
    fs.mkdirSync(repository.lockPath);
    fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
      token: 'stale-owner-token',
      pid: stalePid,
      hostname: os.hostname(),
      acquiredAt: new Date(0).toISOString()
    }));

    process.kill = function (pid, signal) {
      if (pid === stalePid && signal === 0 && !replaced) {
        replaced = true;
        fs.rmSync(repository.lockPath, { recursive: true, force: true });
        fs.mkdirSync(repository.lockPath);
        fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify(replacementOwner));
        throw Object.assign(new Error('old owner disappeared after replacement'), { code: 'ESRCH' });
      }
      return originalKill.call(process, pid, signal);
    };

    assert.throws(
      () => repository.withLock(() => 'must-not-steal-replacement-lock'),
      error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(replaced, true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repository.lockPath, 'owner.json'), 'utf8')),
      replacementOwner
    );
  } finally {
    process.kill = originalKill;
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  assert.throws(() => repository.read(), /Event storage read failed/);
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


test('stale-lock recovery preserves a replacement owner with the same PID and hostname but a different token', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-lock-same-pid-replacement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 20 });
  const originalKill = process.kill;
  const replacementOwner = {
    token: 'replacement-token-same-process',
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString()
  };
  let replaced = false;

  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify({
    token: 'original-token',
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date(0).toISOString()
  }));

  try {
    process.kill = function (pid, signal) {
      if (pid === process.pid && signal === 0 && !replaced) {
        replaced = true;
        fs.rmSync(repository.lockPath, { recursive: true, force: true });
        fs.mkdirSync(repository.lockPath);
        fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify(replacementOwner));
        throw Object.assign(new Error('simulated owner observation raced with replacement'), { code: 'ESRCH' });
      }
      return originalKill.call(process, pid, signal);
    };

    assert.throws(
      () => repository.withLock(() => 'must-not-steal-replacement-lock'),
      error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(replaced, true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repository.lockPath, 'owner.json'), 'utf8')),
      replacementOwner
    );
  } finally {
    process.kill = originalKill;
  }
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

test('event repository propagates unexpected process-liveness errors without reclaiming the lock', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-kill-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 20 });
  const owner = {
    token: 'owner-with-unknown-liveness',
    pid: 2147483645,
    hostname: os.hostname(),
    acquiredAt: new Date(0).toISOString()
  };
  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify(owner));
  const originalKill = process.kill;
  try {
    process.kill = (pid, signal) => {
      if (pid === owner.pid && signal === 0) throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
      return originalKill.call(process, pid, signal);
    };
    assert.throws(
      () => repository.withLock(() => 'must-not-run'),
      error => error.code === 'EIO'
    );
    assert.equal(fs.existsSync(repository.lockPath), true);
  } finally {
    process.kill = originalKill;
  }
});

test('event repository propagates owner metadata read failures other than missing or malformed files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-owner-read-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'), { lockTimeoutMs: 20 });
  fs.mkdirSync(repository.lockPath);
  const ownerPath = path.join(repository.lockPath, 'owner.json');
  const originalRead = fs.readFileSync;
  try {
    fs.readFileSync = function (target, ...args) {
      if (target === ownerPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return originalRead.call(this, target, ...args);
    };
    assert.throws(
      () => repository.withLock(() => 'must-not-run'),
      error => error.code === 'EACCES'
    );
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('event repository does not remove a replacement lock during release', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-release-replacement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new EventRepository(path.join(directory, 'events.json'));
  const replacementOwner = {
    token: 'replacement-during-release',
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString()
  };
  assert.equal(repository.withLock(() => {
    fs.writeFileSync(path.join(repository.lockPath, 'owner.json'), JSON.stringify(replacementOwner));
    return 'operation-finished';
  }), 'operation-finished');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(repository.lockPath, 'owner.json'), 'utf8')),
    replacementOwner
  );
});
