const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ApprovalRepository = require('../../../src/infrastructure/persistence/json/approval.repository');

test('durable approval consume is atomic across processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approvals-'));
  const file = path.join(dir, 'approvals.json');
  const worker = path.join(dir, 'worker.js');
  const repo = new ApprovalRepository(file);

  await repo.save({
    approvalId: 'approval-1',
    executionId: 'execution-1',
    step: 1,
    planRevision: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { target: 'x' },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    decision: { status: 'approved', actorId: 'owner-test', decidedAt: new Date().toISOString() },
    used: false,
    tenantId: 'tenant-a',
    metadata: { tenantId: 'tenant-a' }
  }, { tenantId: 'tenant-a' });

  fs.writeFileSync(worker, `
    const ApprovalRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/approval.repository'))});
    const repo = new ApprovalRepository(process.argv[2]);
    repo.consume('approval-1', new Date().toISOString(), 'tenant-a')
      .then(result => process.exit(result ? 0 : 2))
      .catch(() => process.exit(3));
  `);

  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  })));

  assert.equal(results.filter(code => code === 0).length, 1);
  assert.equal(results.filter(code => code === 2).length, 5);

  const stored = await repo.findById('approval-1', { tenantId: 'tenant-a' });
  assert.equal(stored.used, true);
  assert.ok(stored.usedAt);
});

test('JsonPersistence provisions durable approvals', () => {
  const JsonPersistence = require('../../../src/infrastructure/persistence/json/json-persistence');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-json-persistence-'));
  const persistence = new JsonPersistence({ rootDir: dir });

  assert.ok(persistence.approvals instanceof ApprovalRepository);
  assert.equal(fs.existsSync(path.join(dir, 'approvals.json')), true);

  fs.rmSync(dir, { recursive: true, force: true });
});


test('approval repository does not reclaim an old lock owned by a live process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-live-lock-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file, { lockTimeoutMs: 20 });
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
      token: 'live-owner', pid: process.pid, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(repo.lockPath, old, old);
    assert.throws(() => repo.withLock(() => 'must not run'),
      error => error.code === 'APPROVAL_STORAGE_LOCK_TIMEOUT');
    assert.equal(fs.existsSync(repo.lockPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approval repository recovers a lock whose local owner process is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-dead-lock-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file, { lockTimeoutMs: 100 });
  try {
    fs.mkdirSync(repo.lockPath);
    fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
      token: 'dead-owner', pid: 2147483647, hostname: os.hostname(), acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(repo.lockPath, old, old);
    assert.equal(repo.withLock(() => 'acquired'), 'acquired');
    assert.equal(fs.existsSync(repo.lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('approval repository fails closed on empty or whitespace-only persisted state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-corrupt-state-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file);
  try {
    for (const invalidContent of ['', '   ' + String.fromCharCode(10, 9)]) {
      fs.writeFileSync(file, invalidContent, 'utf8');
      assert.throws(
        () => repo.read(),
        /Approval storage file is empty/,
        'empty approval storage must not be interpreted as an empty approval ledger'
      );
      await assert.rejects(
        () => repo.save({
          approvalId: 'new-approval',
          executionId: 'execution-1',
          step: 1,
          tool: 'danger.write',
          capability: 'external.write',
          tenantId: 'tenant-a'
        }, { tenantId: 'tenant-a' }),
        /Approval storage file is empty/,
        'a write must not overwrite an approval ledger whose persisted state is empty'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approval repository rejects valid JSON with an invalid root shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-invalid-root-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file);
  try {
    for (const invalidContent of ['[]', 'null', '"approval"', '42']) {
      fs.writeFileSync(file, invalidContent, 'utf8');
      assert.throws(() => repo.read(), /Approval storage root must be an object/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('approval repository refuses to consume pending, rejected, expired, or malformed approvals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-consume-gates-'));
  const repo = new ApprovalRepository(path.join(dir, 'approvals.json'));
  const now = Date.now();
  const base = {
    step: 1, planRevision: 1, tool: 'danger.write', capability: 'external.write',
    used: false, tenantId: 'tenant-a', metadata: { tenantId: 'tenant-a' }
  };
  try {
    const records = [
      { ...base, approvalId: 'pending', executionId: 'e-pending', expiresAt: new Date(now + 60000).toISOString() },
      { ...base, approvalId: 'rejected', executionId: 'e-rejected', expiresAt: new Date(now + 60000).toISOString(), decision: { status: 'rejected', actorId: 'owner', decidedAt: new Date(now).toISOString() } },
      { ...base, approvalId: 'expired', executionId: 'e-expired', expiresAt: new Date(now - 1).toISOString(), decision: { status: 'approved', actorId: 'owner', decidedAt: new Date(now - 1000).toISOString() } },
      { ...base, approvalId: 'malformed', executionId: 'e-malformed', expiresAt: 'not-a-date', decision: { status: 'approved', actorId: 'owner', decidedAt: new Date(now).toISOString() } }
    ];
    for (const record of records) await repo.save(record, { tenantId: 'tenant-a' });
    const consumedAt = new Date(now).toISOString();
    for (const record of records) {
      assert.equal(await repo.consume(record.approvalId, consumedAt, 'tenant-a'), false, record.approvalId);
    }
    for (const record of records) {
      assert.equal((await repo.findById(record.approvalId, { tenantId: 'tenant-a' })).used, false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('approval repository rechecks expiry at decision and consumption commit time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-commit-expiry-'));
  const repo = new ApprovalRepository(path.join(dir, 'approvals.json'));
  const now = Date.now();
  const expiresAt = new Date(now + 1000).toISOString();
  const base = {
    step: 1, planRevision: 1, tool: 'danger.write', capability: 'external.write',
    expiresAt, used: false, tenantId: 'tenant-a', metadata: { tenantId: 'tenant-a' }
  };
  try {
    await repo.save({ ...base, approvalId: 'decision-race', executionId: 'execution-decision-race' }, { tenantId: 'tenant-a' });
    await assert.rejects(
      () => repo.recordDecision('decision-race', {
        status: 'approved', actorId: 'owner-a', decidedAt: new Date(now).toISOString()
      }, 'tenant-a', () => now + 1001),
      error => error.code === 'APPROVAL_EXPIRED'
    );
    assert.equal((await repo.findById('decision-race', { tenantId: 'tenant-a' })).decision, undefined);

    await repo.save({
      ...base,
      approvalId: 'consume-race',
      executionId: 'execution-consume-race',
      decision: { status: 'approved', actorId: 'owner-a', decidedAt: new Date(now).toISOString() }
    }, { tenantId: 'tenant-a' });
    assert.equal(await repo.consume(
      'consume-race',
      new Date(now + 999).toISOString(),
      'tenant-a',
      () => now + 1001
    ), false);
    assert.equal((await repo.findById('consume-race', { tenantId: 'tenant-a' })).used, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
