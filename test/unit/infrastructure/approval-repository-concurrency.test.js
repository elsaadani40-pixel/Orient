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

test('durable approval decision is immutable across independent processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-decision-race-'));
  const file = path.join(dir, 'approvals.json');
  const worker = path.join(dir, 'decision-worker.js');
  const repo = new ApprovalRepository(file);
  const now = Date.now();
  try {
    await repo.save({
      approvalId: 'approval-decision-race',
      executionId: 'execution-decision-race',
      step: 1,
      planRevision: 1,
      tool: 'danger.write',
      capability: 'external.write',
      scope: { target: 'x' },
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      used: false,
      tenantId: 'tenant-a',
      metadata: { tenantId: 'tenant-a' }
    }, { tenantId: 'tenant-a' });

    fs.writeFileSync(worker, `
      const ApprovalRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/approval.repository'))});
      const repo = new ApprovalRepository(process.argv[2]);
      const decision = {
        status: process.argv[3],
        actorId: process.argv[4],
        decidedAt: new Date().toISOString()
      };
      repo.recordDecision('approval-decision-race', decision, 'tenant-a')
        .then(() => process.exit(0))
        .catch(error => process.exit(error.code === 'APPROVAL_DECISION_CONFLICT' ? 2 : 3));
    `);

    const contenders = [
      ['approved', 'owner-a'], ['rejected', 'owner-b'],
      ['approved', 'owner-c'], ['rejected', 'owner-d'],
      ['approved', 'owner-e'], ['rejected', 'owner-f']
    ];
    const results = await Promise.all(contenders.map(([decision, actor]) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, file, decision, actor], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    })));

    assert.equal(results.filter(code => code === 0).length, 1);
    assert.equal(results.filter(code => code === 2).length, contenders.length - 1);
    assert.equal(results.filter(code => code === 3).length, 0);

    const stored = await repo.findById('approval-decision-race', { tenantId: 'tenant-a' });
    assert.ok(['approved', 'rejected'].includes(stored.decision?.status));
    assert.ok(contenders.some(([status, actor]) => status === stored.decision.status && actor === stored.decision.actorId));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('JSON approval save cannot overwrite an existing immutable decision or consumed state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-no-overwrite-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file);
  const now = Date.now();
  const original = {
    approvalId: 'approval-no-overwrite',
    executionId: 'execution-no-overwrite',
    step: 1,
    planRevision: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { target: 'original' },
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    used: false,
    tenantId: 'tenant-a',
    metadata: { tenantId: 'tenant-a' }
  };

  try {
    await repo.save(original, { tenantId: 'tenant-a' });
    await repo.recordDecision('approval-no-overwrite', {
      status: 'approved',
      actorId: 'owner-a',
      decidedAt: new Date(now).toISOString()
    }, 'tenant-a', () => now);

    await assert.rejects(
      () => repo.save({
        ...original,
        scope: { target: 'attacker-replacement' },
        used: false,
        decision: null,
        expiresAt: new Date(now + 3600000).toISOString()
      }, { tenantId: 'tenant-a' }),
      error => error.code === 'APPROVAL_ALREADY_EXISTS'
    );

    const stored = await repo.findById('approval-no-overwrite', { tenantId: 'tenant-a' });
    assert.equal(stored.scope.target, 'original');
    assert.equal(stored.decision.status, 'approved');
    assert.equal(stored.decision.actorId, 'owner-a');
    assert.equal(stored.used, false);
    assert.equal(stored.expiresAt, original.expiresAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON approval repository rejects records with conflicting tenant identities', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-tenant-conflict-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file);
  const now = Date.now();
  const conflicting = {
    approvalId: 'approval-tenant-conflict',
    executionId: 'execution-tenant-conflict',
    step: 1,
    planRevision: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { target: 'x' },
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    used: false,
    tenantId: 'tenant-a',
    metadata: { tenantId: 'tenant-b' }
  };

  try {
    await assert.rejects(
      () => repo.save(conflicting, { tenantId: 'tenant-a' }),
      error => error.code === 'APPROVAL_TENANT_MISMATCH'
    );
    await assert.rejects(
      () => repo.save(conflicting, { tenantId: 'tenant-b' }),
      error => error.code === 'APPROVAL_TENANT_MISMATCH'
    );

    // Simulate a legacy/corrupt persisted record to ensure every read/write
    // authorization path fails closed, not only new inserts.
    fs.writeFileSync(file, JSON.stringify({ [conflicting.approvalId]: conflicting }), 'utf8');
    assert.equal(await repo.findById(conflicting.approvalId, { tenantId: 'tenant-a' }), null);
    assert.equal(await repo.findById(conflicting.approvalId, { tenantId: 'tenant-b' }), null);
    assert.deepEqual(await repo.findPending({ tenantId: 'tenant-a' }), []);
    assert.deepEqual(await repo.findByExecution({
      executionId: conflicting.executionId, tenantId: 'tenant-b'
    }), []);
    await assert.rejects(
      () => repo.recordDecision(conflicting.approvalId, {
        status: 'approved', actorId: 'owner-a', decidedAt: new Date(now).toISOString()
      }, 'tenant-a', () => now),
      error => error.code === 'APPROVAL_TENANT_MISMATCH'
    );
    assert.equal(await repo.consume(conflicting.approvalId, new Date(now).toISOString(), 'tenant-b'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON approval repository rejects an unparsable decision timestamp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-invalid-decision-time-'));
  const file = path.join(dir, 'approvals.json');
  const repo = new ApprovalRepository(file);
  const now = Date.now();
  try {
    await repo.save({
      approvalId: 'approval-invalid-decision-time',
      executionId: 'execution-invalid-decision-time',
      step: 1,
      planRevision: 1,
      tool: 'danger.write',
      capability: 'external.write',
      scope: {},
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      used: false,
      tenantId: 'tenant-a',
      metadata: { tenantId: 'tenant-a' }
    }, { tenantId: 'tenant-a' });

    await assert.rejects(
      () => repo.recordDecision('approval-invalid-decision-time', {
        status: 'approved',
        actorId: 'owner-a',
        decidedAt: 'not-a-valid-timestamp'
      }, 'tenant-a', () => now),
      error => error.code === 'APPROVAL_DECISION_INVALID'
    );

    const stored = await repo.findById('approval-invalid-decision-time', { tenantId: 'tenant-a' });
    assert.equal(stored.decision, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

