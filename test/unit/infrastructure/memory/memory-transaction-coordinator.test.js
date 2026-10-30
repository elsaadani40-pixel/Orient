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
    const stale = new Date(Date.now() - f.coordinator.lockTimeoutMs - 5000);
    fs.writeFileSync(f.coordinator.lockFile, JSON.stringify({
      token: 'dead-owner',
      pid: 2147483647,
      hostname: os.hostname(),
      acquiredAt: stale.toISOString()
    }), { mode: 0o600 });
    fs.utimesSync(f.coordinator.lockFile, stale, stale);
    fs.mkdirSync(`${f.coordinator.lockFile}.recovery`, { mode: 0o700 });

    assert.throws(
      () => f.coordinator.acquireLock(),
      error => error.code === 'MEMORY_TRANSACTION_LOCKED'
    );
    assert.equal(fs.existsSync(f.coordinator.lockFile), true);
    assert.equal(fs.existsSync(`${f.coordinator.lockFile}.recovery`), true);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('abandoned recovery marker fails closed with an actionable diagnostic', () => {
  const f = fixture();
  try {
    const stale = new Date(Date.now() - f.coordinator.lockTimeoutMs - 5000);
    fs.writeFileSync(f.coordinator.lockFile, JSON.stringify({
      token: 'dead-owner',
      pid: 2147483647,
      hostname: os.hostname(),
      acquiredAt: stale.toISOString()
    }), { mode: 0o600 });
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

test('release waits for stale recovery and cannot remove a replacement owner lock', async () => {
  const f = fixture();
  let holder;
  let reclaimer;
  try {
    const holderReady = path.join(f.directory, 'holder-ready');
    const releaseHolder = path.join(f.directory, 'release-holder');
    const holderWaiting = path.join(f.directory, 'holder-waiting');
    const reclaimerPaused = path.join(f.directory, 'reclaimer-paused');
    const continueRename = path.join(f.directory, 'continue-rename');
    const quarantined = path.join(f.directory, 'quarantined');
    const continueGateRelease = path.join(f.directory, 'continue-gate-release');
    const holderResult = path.join(f.directory, 'holder-result');
    const reclaimerResult = path.join(f.directory, 'reclaimer-result');
    const coordinatorPath = require.resolve('../../../../src/infrastructure/memory/memory-transaction-coordinator');

    const holderScript = [
      `const fs = require('node:fs');`,
      `const os = require('node:os');`,
      `const Coordinator = require(${JSON.stringify(coordinatorPath)});`,
      `const c = new Coordinator({memoryFile: process.env.MEMORY_FILE, auditFile: process.env.AUDIT_FILE, journalFile: process.env.JOURNAL_FILE});`,
      `const owner = c.acquireLock();`,
      `const staleOwner = {...owner, pid: 2147483647, hostname: os.hostname()};`,
      `fs.writeFileSync(process.env.LOCK_FILE, JSON.stringify(staleOwner) + '\\n');`,
      `const stale = new Date(Date.now() - c.lockTimeoutMs - 5000);`,
      `fs.utimesSync(process.env.LOCK_FILE, stale, stale);`,
      `fs.writeFileSync(process.env.HOLDER_READY, 'ready');`,
      `const originalMkdir = fs.mkdirSync.bind(fs);`,
      `fs.mkdirSync = (target, ...args) => {`,
      `  try { return originalMkdir(target, ...args); } catch (error) {`,
      `    if (target === process.env.RECOVERY_LOCK && error.code === 'EEXIST') fs.writeFileSync(process.env.HOLDER_WAITING, 'waiting');`,
      `    throw error;`,
      `  }`,
      `};`,
      `const deadline = Date.now() + 10000;`,
      `while (!fs.existsSync(process.env.RELEASE_HOLDER)) {`,
      `  if (Date.now() >= deadline) throw new Error('timed out waiting for holder release signal');`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
      `}`,
      `try { c.releaseLock(owner); fs.writeFileSync(process.env.HOLDER_RESULT, 'released'); }`,
      `catch (error) {`,
      `  if (error.code !== 'MEMORY_TRANSACTION_LOCK_OWNERSHIP_LOST') throw error;`,
      `  fs.writeFileSync(process.env.HOLDER_RESULT, 'ownership-lost');`,
      `}`
    ].join('\n');

    const reclaimerScript = [
      `const fs = require('node:fs');`,
      `const Coordinator = require(${JSON.stringify(coordinatorPath)});`,
      `const originalRename = fs.renameSync.bind(fs);`,
      `const originalRmdir = fs.rmdirSync.bind(fs);`,
      `fs.renameSync = (source, destination) => {`,
      `  if (source === process.env.LOCK_FILE && destination.startsWith(process.env.LOCK_FILE + '.stale.')) {`,
      `    fs.writeFileSync(process.env.RECLAIMER_PAUSED, 'paused');`,
      `    const deadline = Date.now() + 10000;`,
      `    while (!fs.existsSync(process.env.CONTINUE_RENAME)) {`,
      `      if (Date.now() >= deadline) throw new Error('timed out waiting to continue quarantine');`,
      `      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
      `    }`,
      `  }`,
      `  return originalRename(source, destination);`,
      `};`,
      `fs.rmdirSync = (target, ...args) => {`,
      `  if (target === process.env.RECOVERY_LOCK) {`,
      `    fs.writeFileSync(process.env.QUARANTINED, 'ready');`,
      `    const deadline = Date.now() + 10000;`,
      `    while (!fs.existsSync(process.env.CONTINUE_GATE_RELEASE)) {`,
      `      if (Date.now() >= deadline) throw new Error('timed out waiting to release recovery gate');`,
      `      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
      `    }`,
      `  }`,
      `  return originalRmdir(target, ...args);`,
      `};`,
      `const c = new Coordinator({memoryFile: process.env.MEMORY_FILE, auditFile: process.env.AUDIT_FILE, journalFile: process.env.JOURNAL_FILE});`,
      `try { c.acquireLock(); throw new Error('expected the replacement owner to contend'); }`,
      `catch (error) { if (error.code !== 'MEMORY_TRANSACTION_LOCKED') throw error; }`,
      `fs.writeFileSync(process.env.RECLAIMER_RESULT, 'contended-safely');`
    ].join('\n');

    const env = {
      ...process.env,
      MEMORY_FILE: f.memoryFile,
      AUDIT_FILE: f.auditFile,
      JOURNAL_FILE: f.journalFile,
      LOCK_FILE: f.coordinator.lockFile,
      RECOVERY_LOCK: `${f.coordinator.lockFile}.recovery`,
      HOLDER_READY: holderReady,
      RELEASE_HOLDER: releaseHolder,
      HOLDER_WAITING: holderWaiting,
      RECLAIMER_PAUSED: reclaimerPaused,
      CONTINUE_RENAME: continueRename,
      QUARANTINED: quarantined,
      CONTINUE_GATE_RELEASE: continueGateRelease,
      HOLDER_RESULT: holderResult,
      RECLAIMER_RESULT: reclaimerResult
    };
    const launch = script => spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env
    });
    const waitFor = async (signal, child, description) => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(signal)) {
        if (child.exitCode !== null) throw new Error(`${description}: child exited early`);
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    const waitExit = child => new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    holder = launch(holderScript);
    let holderStderr = '';
    holder.stderr.on('data', chunk => { holderStderr += chunk.toString(); });
    await waitFor(holderReady, holder, 'initial lock holder');
    reclaimer = launch(reclaimerScript);
    let reclaimerStderr = '';
    reclaimer.stderr.on('data', chunk => { reclaimerStderr += chunk.toString(); });
    await waitFor(reclaimerPaused, reclaimer, 'reclaimer pause before rename');

    fs.writeFileSync(releaseHolder, 'release');
    await waitFor(holderWaiting, holder, 'holder waiting on recovery gate');
    fs.writeFileSync(continueRename, 'continue');
    await waitFor(quarantined, reclaimer, 'old lock quarantined while recovery gate remains held');

    const replacementOwner = f.coordinator.acquireLock();
    const replacementOnDisk = JSON.parse(fs.readFileSync(f.coordinator.lockFile, 'utf8'));
    assert.equal(replacementOnDisk.token, replacementOwner.token, 'a new owner can acquire the now-vacant path');

    fs.writeFileSync(continueGateRelease, 'continue');
    assert.deepEqual(await waitExit(reclaimer), { code: 0, signal: null }, reclaimerStderr);
    assert.deepEqual(await waitExit(holder), { code: 0, signal: null }, holderStderr);
    assert.ok(['released', 'ownership-lost'].includes(fs.readFileSync(holderResult, 'utf8')));
    assert.equal(
      JSON.parse(fs.readFileSync(f.coordinator.lockFile, 'utf8')).token,
      replacementOwner.token,
      'the releaser/reclaimer must not unlink or rename the replacement owner lock'
    );
    f.coordinator.releaseLock(replacementOwner);
  } finally {
    for (const child of [holder, reclaimer]) {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    }
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
