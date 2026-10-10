const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
