const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const MemoryTransactionCoordinator = require('../../../../src/infrastructure/memory/memory-transaction-coordinator');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-transaction-'));
  const memoryFile = path.join(directory, 'memories.json');
  const auditFile = path.join(directory, 'memory-audit.json');
  const journalFile = path.join(directory, 'memory-transaction-journal.json');
  fs.writeFileSync(memoryFile, '[{"id":"before"}]\n');
  fs.writeFileSync(auditFile, '[{"action":"before"}]\n');
  const coordinator = new MemoryTransactionCoordinator({ memoryFile, auditFile, journalFile });
  return { directory, memoryFile, auditFile, journalFile, coordinator };
}

test('prepared memory transaction is rolled back after a child process crashes between writes', () => {
  const f = fixture();
  try {
    const script = [
      `const Coordinator = require(${JSON.stringify(require.resolve('../../../../src/infrastructure/memory/memory-transaction-coordinator'))});`,
      `const fs = require('node:fs');`,
      `const c = new Coordinator({memoryFile: process.env.MEMORY_FILE, auditFile: process.env.AUDIT_FILE, journalFile: process.env.JOURNAL_FILE});`,
      `c.run(() => { fs.writeFileSync(process.env.MEMORY_FILE, '[{"id":"after"}]'); fs.writeFileSync(process.env.AUDIT_FILE, '[{"action":"after"}]'); process.exit(73); });`
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, MEMORY_FILE: f.memoryFile, AUDIT_FILE: f.auditFile, JOURNAL_FILE: f.journalFile }
    });
    assert.equal(child.status, 73, child.stderr);
    assert.ok(fs.existsSync(f.journalFile), 'prepared journal must survive process death');

    const recovered = f.coordinator.recover();
    assert.deepEqual(recovered, { recovered: true, phase: 'prepared' });
    assert.equal(fs.readFileSync(f.memoryFile, 'utf8'), '[{"id":"before"}]\n');
    assert.equal(fs.readFileSync(f.auditFile, 'utf8'), '[{"action":"before"}]\n');
    assert.equal(fs.existsSync(f.journalFile), false);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('committed memory transaction keeps both files and cleans its journal', () => {
  const f = fixture();
  try {
    const result = f.coordinator.run(() => {
      fs.writeFileSync(f.memoryFile, '[{"id":"committed"}]\n');
      fs.writeFileSync(f.auditFile, '[{"action":"committed"}]\n');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(JSON.parse(fs.readFileSync(f.memoryFile, 'utf8'))[0].id, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(f.auditFile, 'utf8'))[0].action, 'committed');
    assert.equal(fs.existsSync(f.journalFile), false);
    assert.equal(fs.existsSync(f.coordinator.lockFile), false);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('corrupt transaction journal fails closed instead of serving potentially inconsistent memory', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.journalFile, '{"phase":"prepared"', 'utf8');
    assert.throws(
      () => f.coordinator.recover(),
      error => error.code === 'MEMORY_TRANSACTION_JOURNAL_CORRUPT'
    );
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('failed operation restores memory and audit before-images', () => {
  const f = fixture();
  try {
    assert.throws(() => f.coordinator.run(() => {
      fs.writeFileSync(f.memoryFile, '[{"id":"partial"}]\n');
      fs.writeFileSync(f.auditFile, '[{"action":"partial"}]\n');
      throw new Error('simulated operation failure');
    }), /simulated operation failure/);
    assert.equal(fs.readFileSync(f.memoryFile, 'utf8'), '[{"id":"before"}]\n');
    assert.equal(fs.readFileSync(f.auditFile, 'utf8'), '[{"action":"before"}]\n');
    assert.equal(fs.existsSync(f.journalFile), false);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('MemoryService add crash after durable audit append is rolled back on restart', () => {
  const f = fixture();
  try {
    // Empty valid stores avoid a legacy-data migration before the transaction starts.
    fs.writeFileSync(f.memoryFile, '[]');
    fs.writeFileSync(f.auditFile, '[]');
    const script = [
      `const MemoryRepository = require(${JSON.stringify(require.resolve('../../../../src/infrastructure/memory/json-memory.repository'))});`,
      `const AuditRepository = require(${JSON.stringify(require.resolve('../../../../src/infrastructure/memory/memory-audit.repository'))});`,
      `const MemoryService = require(${JSON.stringify(require.resolve('../../../../src/application/memory/memory.service'))});`,
      `const Coordinator = require(${JSON.stringify(require.resolve('../../../../src/infrastructure/memory/memory-transaction-coordinator'))});`,
      `const coordinator = new Coordinator({memoryFile: process.env.MEMORY_FILE, auditFile: process.env.AUDIT_FILE, journalFile: process.env.JOURNAL_FILE});`,
      `coordinator.recover();`,
      `const memoryRepository = new MemoryRepository(process.env.MEMORY_FILE);`,
      `const auditRepository = new AuditRepository(process.env.AUDIT_FILE);`,
      `const originalAppend = auditRepository.append.bind(auditRepository);`,
      `auditRepository.append = event => { const result = originalAppend(event); process.exit(74); };`,
      `const service = new MemoryService(memoryRepository, {auditRepository, transactionCoordinator: coordinator});`,
      `service.add('crash during audit commit', {}, {tenantId: 'tenant-crash-test'});`
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, MEMORY_FILE: f.memoryFile, AUDIT_FILE: f.auditFile, JOURNAL_FILE: f.journalFile }
    });
    assert.equal(child.status, 74, child.stderr);
    assert.notEqual(JSON.parse(fs.readFileSync(f.memoryFile, 'utf8')).length, 0);
    assert.notEqual(JSON.parse(fs.readFileSync(f.auditFile, 'utf8')).length, 0);

    f.coordinator.recover();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.memoryFile, 'utf8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.auditFile, 'utf8')), []);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('startup recovery refuses to race a live transaction owner', () => {
  const f = fixture();
  try {
    const owner = f.coordinator.acquireLock();
    assert.throws(
      () => f.coordinator.recover(),
      error => error.code === 'MEMORY_TRANSACTION_LOCKED'
    );
    f.coordinator.releaseLock(owner);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('read waits for another process transaction lock before reading shared files', async () => {
  const f = fixture();
  let child;
  try {
    const signalPath = path.join(f.directory, 'lock-held');
    const script = [
      `const Coordinator = require(${JSON.stringify(require.resolve('../../../../src/infrastructure/memory/memory-transaction-coordinator'))});`,
      `const fs = require('node:fs');`,
      `const c = new Coordinator({memoryFile: process.env.MEMORY_FILE, auditFile: process.env.AUDIT_FILE, journalFile: process.env.JOURNAL_FILE});`,
      `const owner = c.acquireLock();`,
      `fs.writeFileSync(process.env.SIGNAL_FILE, 'ready');`,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);`,
      `c.releaseLock(owner);`
    ].join('\n');
    child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        MEMORY_FILE: f.memoryFile,
        AUDIT_FILE: f.auditFile,
        JOURNAL_FILE: f.journalFile,
        SIGNAL_FILE: signalPath
      }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(signalPath)) {
      if (child.exitCode !== null) throw new Error('lock holder exited early: ' + stderr);
      if (Date.now() >= deadline) throw new Error('timed out waiting for lock holder: ' + stderr);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const startedAt = Date.now();
    const result = f.coordinator.read(() => fs.readFileSync(f.memoryFile, 'utf8'));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 150, `read should wait for lock release; waited ${elapsed}ms`);
    assert.equal(result, '[{"id":"before"}]\n');
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});


test('failed transaction lock initialization removes only its own unusable lock file', () => {
  const f = fixture();
  const originalFsync = fs.fsyncSync;
  let failed = false;
  try {
    fs.fsyncSync = function (...args) {
      if (!failed) {
        failed = true;
        throw new Error('simulated lock metadata fsync failure');
      }
      return originalFsync.apply(this, args);
    };
    assert.throws(
      () => f.coordinator.acquireLock(),
      /simulated lock metadata fsync failure/
    );
    assert.equal(fs.existsSync(f.coordinator.lockFile), false);
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});


test('stale lock recovery refuses to race another recovery owner', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.coordinator.lockFile, '', { mode: 0o600 });
    const stale = new Date(Date.now() - f.coordinator.lockTimeoutMs - 5000);
    fs.utimesSync(f.coordinator.lockFile, stale, stale);
    fs.mkdirSync(`${f.coordinator.lockFile}.recovery`, { mode: 0o700 });

    assert.throws(
      () => f.coordinator.acquireLock(),
      error => error.code === 'MEMORY_TRANSACTION_LOCKED'
    );
    assert.equal(fs.existsSync(f.coordinator.lockFile), true);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('abandoned recovery marker fails closed with an actionable diagnostic', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.coordinator.lockFile, '', { mode: 0o600 });
    const stale = new Date(Date.now() - f.coordinator.lockTimeoutMs - 5000);
    fs.utimesSync(f.coordinator.lockFile, stale, stale);
    const recoveryPath = `${f.coordinator.lockFile}.recovery`;
    fs.mkdirSync(recoveryPath, { mode: 0o700 });
    fs.utimesSync(recoveryPath, stale, stale);

    assert.throws(
      () => f.coordinator.acquireLock(),
      error => error.code === 'MEMORY_TRANSACTION_RECOVERY_LOCK_ABANDONED' &&
        /refusing unsafe automatic cleanup/.test(error.message)
    );
    assert.equal(fs.existsSync(recoveryPath), true, 'the marker must not be removed automatically');
    assert.equal(fs.existsSync(f.coordinator.lockFile), true, 'the original lock must remain untouched');
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('stale malformed transaction lock fails closed instead of reclaiming a possibly live initializer', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.coordinator.lockFile, '', { mode: 0o600 });
    const stale = new Date(Date.now() - f.coordinator.lockTimeoutMs - 5000);
    fs.utimesSync(f.coordinator.lockFile, stale, stale);

    assert.throws(
      () => f.coordinator.acquireLock(),
      error => error.code === 'MEMORY_TRANSACTION_MALFORMED_LOCK_ABANDONED'
    );
    assert.equal(fs.readFileSync(f.coordinator.lockFile, 'utf8'), '');
    assert.equal(fs.existsSync(`${f.coordinator.lockFile}.recovery`), false);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
