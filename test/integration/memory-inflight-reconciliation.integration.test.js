'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const JsonMemoryRepository = require('../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../src/infrastructure/memory/memory-audit.repository');
const MemoryTransactionCoordinator = require('../../src/infrastructure/memory/memory-transaction-coordinator');
const MemoryService = require('../../src/application/memory/memory.service');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-inflight-'));
  const memoryFile = path.join(directory, 'memory.json');
  const auditFile = path.join(directory, 'memory-audit.json');
  const coordinator = new MemoryTransactionCoordinator({
    memoryFile,
    auditFile,
    journalFile: path.join(directory, 'memory-transaction-journal.json')
  });
  coordinator.recover();
  const repository = new JsonMemoryRepository(memoryFile);
  const auditRepository = new MemoryAuditRepository(auditFile);
  const service = new MemoryService(repository, {
    auditRepository,
    transactionCoordinator: coordinator
  });
  return { directory, coordinator, repository, auditRepository, service };
}

async function waitForFile(filePath, child, getStderr, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (child.exitCode !== null) {
      throw new Error('Child exited before reaching the in-flight barrier: ' + getStderr());
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for in-flight barrier: ' + getStderr());
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function runInFlightMutation(mode) {
  const fixture = createFixture();
  const tenantId = 'tenant-memory-inflight';
  const operationId = mode === 'add' ? 'operation-add-inflight' : 'operation-delete-inflight';
  const text = 'memory mutation visible before its audit receipt';
  let memoryId = null;
  let child = null;
  let childExit = null;
  const signalPath = path.join(fixture.directory, 'audit-append-started');
  const releasePath = path.join(fixture.directory, 'release-audit-append');

  try {
    if (mode === 'delete') {
      const seeded = fixture.service.add('target memory for in-flight delete', {}, {
        tenantId,
        memoryScope: 'personal',
        operationId: 'operation-seed-delete-target'
      });
      memoryId = seeded.id;
    }

    const root = path.resolve(__dirname, '../..');
    const script = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const root = ' + JSON.stringify(root) + ';',
      'const directory = ' + JSON.stringify(fixture.directory) + ';',
      'const mode = ' + JSON.stringify(mode) + ';',
      'const tenantId = ' + JSON.stringify(tenantId) + ';',
      'const operationId = ' + JSON.stringify(operationId) + ';',
      'const text = ' + JSON.stringify(text) + ';',
      'const memoryId = ' + JSON.stringify(memoryId) + ';',
      'const signalPath = ' + JSON.stringify(signalPath) + ';',
      'const releasePath = ' + JSON.stringify(releasePath) + ';',
      'const Coordinator = require(path.join(root, "src/infrastructure/memory/memory-transaction-coordinator"));',
      'const Repository = require(path.join(root, "src/infrastructure/memory/json-memory.repository"));',
      'const AuditRepository = require(path.join(root, "src/infrastructure/memory/memory-audit.repository"));',
      'const Service = require(path.join(root, "src/application/memory/memory.service"));',
      'const memoryFile = path.join(directory, "memory.json");',
      'const auditFile = path.join(directory, "memory-audit.json");',
      'const coordinator = new Coordinator({ memoryFile, auditFile, journalFile: path.join(directory, "memory-transaction-journal.json") });',
      'coordinator.recover();',
      'const auditRepository = new AuditRepository(auditFile);',
      'const originalAppend = auditRepository.append.bind(auditRepository);',
      'auditRepository.append = event => {',
      '  if (event.operationId === operationId) {',
      '    fs.writeFileSync(signalPath, "ready");',
      '    const waitCell = new Int32Array(new SharedArrayBuffer(4));',
      '    const deadline = Date.now() + 10000;',
      '    while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 10);',
      '    if (!fs.existsSync(releasePath)) throw new Error("in-flight audit barrier timed out");',
      '  }',
      '  return originalAppend(event);',
      '};',
      'const service = new Service(new Repository(memoryFile), { auditRepository, transactionCoordinator: coordinator });',
      'const context = { tenantId, memoryScope: "personal", operationId };',
      'if (mode === "add") service.add(text, { scope: "personal" }, context);',
      'else service.delete(memoryId, context);'
    ].join(String.fromCharCode(10));

    child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    childExit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });

    try {
      await waitForFile(signalPath, child, () => stderr);
      const input = mode === 'add'
        ? { text, scope: 'personal' }
        : { id: memoryId, scope: 'personal' };
      const context = { tenantId, memoryScope: 'personal', operationId };
      const duringMutation = fixture.service.reconcileToolOperation(
        mode === 'add' ? 'memory.add' : 'memory.delete',
        input,
        context
      );
      assert.equal(duringMutation.status, 'unknown', 'no receipt may be inferred from target state while the audit commit is pending');
      assert.equal(
        fixture.auditRepository.findByOperationId(operationId, tenantId, 'personal').length,
        0,
        'the target mutation must not appear committed before its receipt is appended'
      );
    } finally {
      fs.writeFileSync(releasePath, 'release');
    }

    const exited = await childExit;
    assert.equal(exited.code, 0, exited.stderr || 'child mutation process failed');
    const input = mode === 'add'
      ? { text, scope: 'personal' }
      : { id: memoryId, scope: 'personal' };
    const context = { tenantId, memoryScope: 'personal', operationId };
    const afterCommit = fixture.service.reconcileToolOperation(
      mode === 'add' ? 'memory.add' : 'memory.delete',
      input,
      context
    );
    assert.equal(afterCommit.status, 'completed');
    assert.equal(
      fixture.auditRepository.findByOperationId(operationId, tenantId, 'personal').length,
      1,
      'the committed mutation must have exactly one operation receipt'
    );
    if (mode === 'add') assert.equal(afterCommit.result.text, text);
    else assert.equal(afterCommit.result, true);
  } finally {
    if (child && child.exitCode === null) {
      try { fs.writeFileSync(releasePath, 'release'); } catch {}
      if (childExit) {
        await Promise.race([
          childExit,
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
}

test('memory.add reconciliation stays unknown while its transaction has changed memory but not appended the audit receipt', async () => {
  await runInFlightMutation('add');
});

test('memory.delete reconciliation stays unknown while archive is applied but its audit receipt is pending', async () => {
  await runInFlightMutation('delete');
});
