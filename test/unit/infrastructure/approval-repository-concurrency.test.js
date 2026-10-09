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
