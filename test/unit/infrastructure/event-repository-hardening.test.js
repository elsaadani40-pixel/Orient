const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EventRepository =
  require('../../../src/infrastructure/persistence/json/event.repository');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'events.json');
  const repository = new EventRepository(filePath, options);
  return { root, filePath, repository };
}

test('read rejects a symbolic-link event file without reading its target', t => {
  const { root, filePath, repository } = fixture(t);
  const secretPath = path.join(root, 'outside.json');
  fs.writeFileSync(secretPath, JSON.stringify([{ id: 'secret' }]));
  fs.unlinkSync(filePath);
  fs.symlinkSync(secretPath, filePath);

  assert.throws(
    () => repository.read(),
    error => error.code === 'EVENT_STORAGE_CORRUPT'
  );
});

test('read rejects a directory in place of the event file', t => {
  const { filePath, repository } = fixture(t);
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath);

  assert.throws(
    () => repository.read(),
    error => error.code === 'EVENT_STORAGE_CORRUPT'
  );
});

test('read rejects malformed JSON with a stable corruption code', t => {
  const { filePath, repository } = fixture(t);
  fs.writeFileSync(filePath, '{"unterminated":');

  assert.throws(
    () => repository.read(),
    error => error.code === 'EVENT_STORAGE_CORRUPT' &&
      error.cause instanceof SyntaxError
  );
});

test('read rejects a valid JSON root that is not an array', t => {
  const { filePath, repository } = fixture(t);
  fs.writeFileSync(filePath, JSON.stringify({ events: [] }));

  assert.throws(
    () => repository.read(),
    error => error.code === 'EVENT_STORAGE_CORRUPT'
  );
});

test('read rejects files larger than the configured hard limit before parsing', t => {
  const { filePath, repository } = fixture(t);
  fs.truncateSync(filePath, 64 * 1024 * 1024 + 1);

  assert.throws(
    () => repository.read(),
    error => error.code === 'EVENT_STORAGE_TOO_LARGE'
  );
});

test('a stale lock times out without reclaiming or modifying its contents', t => {
  const { repository } = fixture(t, { lockTimeoutMs: 1 });
  const marker = path.join(repository.lockPath, 'operator-owned-marker');
  fs.mkdirSync(repository.lockPath);
  fs.writeFileSync(marker, 'leave-me-alone');

  assert.throws(
    () => repository.withLock(() => 'unreachable'),
    error => error.code === 'EVENT_STORAGE_LOCK_TIMEOUT'
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), 'leave-me-alone');
  assert.equal(fs.existsSync(repository.lockPath), true);
});

test('lock is released after the protected operation throws', t => {
  const { repository } = fixture(t);

  assert.throws(
    () => repository.withLock(() => {
      throw new Error('operation failed');
    }),
    /operation failed/
  );
  assert.equal(fs.existsSync(repository.lockPath), false);
});

test('lock release never removes a successor lock acquired during the operation', t => {
  const { repository, root } = fixture(t);
  const displacedLock = path.join(root, 'displaced-lock');
  const successorMarker = path.join(repository.lockPath, 'successor-owner.json');

  assert.throws(
    () => repository.withLock(() => {
      fs.renameSync(repository.lockPath, displacedLock);
      fs.mkdirSync(repository.lockPath);
      fs.writeFileSync(successorMarker, '{"owner":"successor"}');
    }),
    error => error.code === 'ENOENT'
  );

  assert.equal(fs.readFileSync(successorMarker, 'utf8'), '{"owner":"successor"}');
  assert.equal(fs.existsSync(displacedLock), true);
});

test('atomic write failure preserves the previous event file and removes its temporary file', t => {
  const { filePath, repository } = fixture(t);
  const original = fs.readFileSync(filePath, 'utf8');
  const originalRename = fs.renameSync;

  try {
    fs.renameSync = () => {
      const error = new Error('simulated rename failure');
      error.code = 'EIO';
      throw error;
    };

    assert.throws(
      () => repository.write([{ id: 'new-event', type: 'test' }]),
      error => error.code === 'EIO'
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter(name => name.startsWith('events.json.tmp.')),
    []
  );
});

test('JSON adapter refuses mission-event writes carrying a worker principal', t => {
  const { repository } = fixture(t);

  assert.throws(
    () => repository.appendMissionEvent(
      { id: 'worker-event', aggregateId: 'mission-1', type: 'mission.started' },
      { workerPrincipal: { id: 'worker-1' } }
    ),
    error => error.code === 'WORKER_DURABLE_FENCING_UNSUPPORTED' &&
      error.status === 503
  );
  assert.equal(repository.count(), 0);
});

test('mission event sequence conflicts are rejected without persisting the event', t => {
  const { repository } = fixture(t);
  repository.appendMissionEvent({
    id: 'mission-event-1',
    aggregateId: 'mission-1',
    type: 'mission.started',
    data: {}
  });

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'mission-event-3',
      aggregateId: 'mission-1',
      sequence: 3,
      type: 'mission.progressed',
      data: {}
    }),
    error => error.code === 'MISSION_EVENT_SEQUENCE_CONFLICT'
  );
  assert.deepEqual(
    repository.findByAggregateId('mission-1').map(event => event.id),
    ['mission-event-1']
  );
});

test('mission event identity conflicts cannot overwrite an existing event id', t => {
  const { repository } = fixture(t);
  repository.appendMissionEvent({
    id: 'mission-event-identity',
    aggregateId: 'mission-1',
    type: 'mission.started',
    data: { state: 'original' }
  });

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'mission-event-identity',
      aggregateId: 'mission-1',
      type: 'mission.completed',
      data: { state: 'changed' }
    }),
    error => error.code === 'MISSION_EVENT_ID_CONFLICT'
  );
  assert.equal(repository.findByAggregateId('mission-1')[0].type, 'mission.started');
});

test('aggregate events are returned in sequence order', t => {
  const { repository } = fixture(t);
  repository.appendMissionEvent({
    id: 'sequence-1', aggregateId: 'mission-sort', sequence: 1,
    type: 'mission.started', data: {}
  });
  repository.appendMissionEvent({
    id: 'sequence-2', aggregateId: 'mission-sort', sequence: 2,
    type: 'mission.progressed', data: {}
  });

  assert.deepEqual(
    repository.findByAggregateId('mission-sort').map(event => event.sequence),
    [1, 2]
  );
});

test('execution, goal, and type queries apply their filters', t => {
  const { repository } = fixture(t);
  repository.appendMany([
    { id: 'query-1', executionId: 'execution-a', goalId: 'goal-a', type: 'task.started', data: {} },
    { id: 'query-2', executionId: 'execution-b', goalId: 'goal-a', type: 'task.completed', data: {} },
    { id: 'query-3', executionId: 'execution-a', goalId: 'goal-b', type: 'task.started', data: {} }
  ]);

  assert.deepEqual(repository.findByExecutionId('execution-a').map(event => event.id), ['query-1', 'query-3']);
  assert.deepEqual(repository.findByGoalId('goal-a').map(event => event.id), ['query-1', 'query-2']);
  assert.deepEqual(repository.findByType('task.started').map(event => event.id), ['query-1', 'query-3']);
  assert.deepEqual(repository.findByExecutionId('').map(event => event.id), []);
  assert.deepEqual(repository.findByGoalId('').map(event => event.id), []);
  assert.deepEqual(repository.findByType('').map(event => event.id), []);
});

test('concurrent processes append without losing or overwriting events', { timeout: 15000 }, async t => {
  const { filePath, repository } = fixture(t, { lockTimeoutMs: 10000 });
  const modulePath = require.resolve('../../../src/infrastructure/persistence/json/event.repository');
  const script = `const EventRepository = require(${JSON.stringify(modulePath)});\nconst repository = new EventRepository(process.argv[1], { lockTimeoutMs: 10000 });\nrepository.append({ id: process.argv[2], type: 'concurrent.write' });\n`;

  const appendFromProcess = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, filePath, id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`child process exited with ${code}: ${stderr}`));
    });
  });

  await Promise.all([appendFromProcess('concurrent-a'), appendFromProcess('concurrent-b')]);
  assert.deepEqual(repository.findAll().map(event => event.id).sort(), ['concurrent-a', 'concurrent-b']);
});

test('clear removes all events while preserving a usable repository', t => {
  const { repository } = fixture(t);
  repository.appendMany([
    { id: 'clear-1', type: 'task.started', data: {} },
    { id: 'clear-2', type: 'task.completed', data: {} }
  ]);

  repository.clear();

  assert.equal(repository.count(), 0);
  assert.deepEqual(repository.findAll(), []);
  assert.equal(repository.append({ id: 'after-clear', type: 'task.started', data: {} }).id, 'after-clear');
});

test('constructor rejects a missing file path and invalid lock timeout', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-event-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => new EventRepository(''), TypeError);
  assert.throws(
    () => new EventRepository(path.join(root, 'events.json'), { lockTimeoutMs: 0 }),
    TypeError
  );
});
