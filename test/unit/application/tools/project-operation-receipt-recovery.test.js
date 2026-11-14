'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const createProjectTools = require('../../../../src/application/tools/project.tools');
const ProjectOperationReceiptStore = require('../../../../src/infrastructure/execution/project-operation-receipt-store');

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-receipt-workspace-'));
  const receiptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-project-receipts-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const store = new ProjectOperationReceiptStore({ directory: receiptDirectory });
    const tools = createProjectTools({
      projectRoot: root,
      policy: { allowRead: true, allowWrite: true, allowCommands: false, allowGit: false },
      operationReceiptStore: store
    });
    await run({ root, store, execute: tools.find(tool => tool.name === 'project.execute_change') });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(receiptDirectory, { recursive: true, force: true });
  }
}

function waitForChildOutput(child, marker, timeoutMs = 8000) {
  let output = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for child marker ' + marker + '; stdout=' + output + '; stderr=' + stderr));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve({ output, stderr });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error('Child exited before marker ' + marker + ' (code=' + code + ', signal=' + signal + '); stderr=' + stderr));
      }
    });
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function receiptInput(operationId, tenantId = 'tenant-a') {
  return {
    operationId,
    tenantId,
    workspaceId: 'a'.repeat(64),
    changeSetHash: 'b'.repeat(64),
    result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
  };
}

test('project mutation declares receipt-backed reconciliation in tool metadata', async () => {
  await withFixture(async ({ execute }) => {
    assert.equal(execute.effects, 'local_mutation');
    assert.equal(execute.idempotency, 'reconcilable');
    assert.equal(typeof execute.reconcile, 'function');
  });
});

test('pending operation intents are tenant-scoped and cannot be rebound to different changes', async () => {
  await withFixture(async ({ store }) => {
    const identity = {
      operationId: 'pending-intent-identity',
      tenantId: 'tenant-a',
      workspaceId: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64)
    };
    const first = store.beginIntent(identity);
    assert.equal(first.created, true);
    assert.equal(store.readIntent(identity).status, 'pending');

    const duplicate = store.beginIntent(identity);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.intent.changeSetHash, identity.changeSetHash);

    assert.equal(store.readIntent({ ...identity, tenantId: 'tenant-b' }), null);
    assert.throws(
      () => store.beginIntent({ ...identity, changeSetHash: 'c'.repeat(64) }),
      error => error?.code === 'PROJECT_OPERATION_INTENT_IDENTITY_CONFLICT'
    );
  });
});

test('intent reads reject symbolic links without following them', async () => {
  await withFixture(async ({ store }) => {
    if (typeof require('node:fs').constants.O_NOFOLLOW !== 'number') {
      assert.throws(
        () => store.readIntent({ operationId: 'symlink-intent', tenantId: 'tenant-a' }),
        error => error?.code === 'PROJECT_OPERATION_INTENT_UNSAFE_FILESYSTEM'
      );
      return;
    }

    const identity = {
      operationId: 'symlink-intent',
      tenantId: 'tenant-a',
      workspaceId: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64)
    };
    const target = path.join(path.dirname(store.intentPath(identity.operationId, identity.tenantId)), 'external-intent-target.json');
    await fs.writeFile(target, JSON.stringify({
      version: 1,
      status: 'pending',
      operationId: identity.operationId,
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      changeSetHash: identity.changeSetHash,
      recordedAt: new Date().toISOString()
    }));
    await fs.symlink(target, store.intentPath(identity.operationId, identity.tenantId));
    assert.throws(
      () => store.readIntent(identity),
      error => error?.code === 'PROJECT_OPERATION_INTENT_CORRUPT'
    );
  });
});

test('verified project mutation writes a tenant-scoped receipt and reconciles only from that receipt', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'approved content\n' }]
    };
    const context = { operationId: 'operation-project-001', tenantId: 'tenant-a' };
    const result = await execute.execute(input, context);
    assert.equal(result.status, 'verified');
    assert.equal((await fs.readFile(path.join(root, 'src/generated.txt'), 'utf8')), 'approved content\n');

    const receipt = store.read(context);
    assert.equal(receipt.operationId, context.operationId);
    assert.equal(receipt.tenantId, context.tenantId);
    assert.equal(receipt.result.status, 'verified');
    assert.equal(store.readIntent(context).status, 'pending', 'the durable intent is retained as an audit marker; the verified receipt is authoritative');

    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'completed');
    assert.deepEqual(recovered.result, receipt.result);
  });
});

test('matching workspace bytes without a receipt remain a fail-closed conflict', async () => {
  await withFixture(async ({ root, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'possibly external\n' }]
    };
    await fs.writeFile(path.join(root, 'src/generated.txt'), 'possibly external\n');
    const recovered = await execute.reconcile(input, {
      operationId: 'operation-without-receipt',
      tenantId: 'tenant-a'
    });
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_missing');
  });
});

test('receipt from another tenant cannot reconcile the same operation ID', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'approved content\n' }]
    };
    await fs.writeFile(path.join(root, 'src/generated.txt'), 'approved content\n');
    const context = { operationId: 'shared-operation', tenantId: 'tenant-a' };
    store.write({
      ...context,
      workspaceId: require('node:crypto').createHash('sha256').update(path.resolve(root), 'utf8').digest('hex'),
      changeSetHash: require('node:crypto').createHash('sha256').update(JSON.stringify(input.proposals.map(({ action, path: proposalPath, content, expectedContentSha256 }) => ({
        action, path: proposalPath, content, ...(expectedContentSha256 ? { expectedContentSha256 } : {})
      }))), 'utf8').digest('hex'),
      result: {
        status: 'verified',
        verification: { status: 'passed', failed: 0 },
        modification: { applied: true }
      }
    });
    const recovered = await execute.reconcile(input, {
      operationId: context.operationId,
      tenantId: 'tenant-b'
    });
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_missing');
  });
});


test('receipt persistence failure after a verified mutation remains unreconciled and cannot be mistaken for success', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/receipt-write-failure.txt', content: 'verified but receipt unavailable\n' }]
    };
    const context = { operationId: 'operation-receipt-write-failure', tenantId: 'tenant-a' };
    store.write = () => {
      const error = new Error('simulated durable receipt storage failure');
      error.code = 'RECEIPT_STORAGE_UNAVAILABLE';
      throw error;
    };

    await assert.rejects(execute.execute(input, context), /simulated durable receipt storage failure/);
    assert.equal(
      await fs.readFile(path.join(root, 'src/receipt-write-failure.txt'), 'utf8'),
      'verified but receipt unavailable\n'
    );

    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_outcome_unknown');
    assert.ok(recovered.intent, 'pending intent preserves uncertainty after receipt persistence fails');
    await assert.rejects(
      execute.execute(input, context),
      error => error?.code === 'PROJECT_OPERATION_OUTCOME_UNKNOWN'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'src/receipt-write-failure.txt'), 'utf8'),
      'verified but receipt unavailable\n',
      'retry must not replay a mutation whose receipt could not be committed'
    );
  });
});


test('a receipt bound to different proposal content is a conflict, even when workspace files match the new proposal', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const original = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'original verified content\\n' }]
    };
    const context = { operationId: 'operation-proposal-mismatch', tenantId: 'tenant-a' };
    const result = await execute.execute(original, context);
    assert.equal(result.status, 'verified');

    const changed = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'different content\\n' }]
    };
    await fs.writeFile(path.join(root, 'src/generated.txt'), 'different content\\n');
    const recovered = await execute.reconcile(changed, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_receipt_identity_conflict');
  });
});

test('a corrupt durable receipt fails closed instead of returning a recovered result', async () => {
  await withFixture(async ({ store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/generated.txt', content: 'verified content\\n' }]
    };
    const context = { operationId: 'operation-corrupt-receipt', tenantId: 'tenant-a' };
    const result = await execute.execute(input, context);
    assert.equal(result.status, 'verified');

    await fs.writeFile(store.receiptPath(context.operationId, context.tenantId), '{not valid json', 'utf8');
    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'PROJECT_OPERATION_RECEIPT_CORRUPT');
  });
});

test('a durable pending intent blocks replay when a crash leaves matching workspace bytes without a receipt', async () => {
  await withFixture(async ({ root, store, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/uncertain-operation.txt', content: 'possibly applied\\n' }]
    };
    const context = { operationId: 'operation-crash-window', tenantId: 'tenant-a' };
    const workspaceId = require('node:crypto').createHash('sha256')
      .update(path.resolve(root), 'utf8').digest('hex');
    const changeSetHash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify(input.proposals.map(({ action, path: proposalPath, content, expectedContentSha256 }) => ({
        action, path: proposalPath, content, ...(expectedContentSha256 ? { expectedContentSha256 } : {})
      }))), 'utf8').digest('hex');

    store.beginIntent({ ...context, workspaceId, changeSetHash });
    await fs.writeFile(path.join(root, 'src/uncertain-operation.txt'), 'possibly applied\\n');

    const recovered = await execute.reconcile(input, context);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.reason, 'operation_outcome_unknown');

    await assert.rejects(
      execute.execute(input, context),
      error => error?.code === 'PROJECT_OPERATION_OUTCOME_UNKNOWN'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'src/uncertain-operation.txt'), 'utf8'),
      'possibly applied\\n',
      'matching bytes alone must not authorize replay or claim completion'
    );
  });
});

test('a receipted operation ID is not replayed when the workspace has drifted', async () => {
  await withFixture(async ({ root, execute }) => {
    const input = {
      proposals: [{ action: 'create', path: 'src/replay-guard.txt', content: 'verified original\\n' }]
    };
    const context = { operationId: 'operation-replay-guard', tenantId: 'tenant-a' };
    const first = await execute.execute(input, context);
    assert.equal(first.status, 'verified');

    // Simulate an intervening change after the original operation completed.
    await fs.writeFile(path.join(root, 'src/replay-guard.txt'), 'external change\\n');

    await assert.rejects(
      execute.execute(input, context),
      error => error?.code === 'PROJECT_OPERATION_REPLAY_CONFLICT'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'src/replay-guard.txt'), 'utf8'),
      'external change\\n',
      'a repeated operation must not overwrite workspace drift'
    );
  });
});



test('intent and receipt reads reject oversized files with bounded descriptor reads', async () => {
  await withFixture(async ({ store }) => {
    const intentIdentity = { operationId: 'oversized-intent', tenantId: 'tenant-a' };
    fsSync.writeFileSync(store.intentPath(intentIdentity.operationId, intentIdentity.tenantId), 'x'.repeat(4 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => store.readIntent(intentIdentity), error => error?.code === 'PROJECT_OPERATION_INTENT_CORRUPT');

    const receiptIdentity = { operationId: 'oversized-receipt', tenantId: 'tenant-a' };
    fsSync.writeFileSync(store.receiptPath(receiptIdentity.operationId, receiptIdentity.tenantId), 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => store.read(receiptIdentity), error => error?.code === 'PROJECT_OPERATION_RECEIPT_CORRUPT');
  });
});

test('receipt reads reject symbolic links without following them', async () => {
  await withFixture(async ({ store }) => {
    if (typeof require('node:fs').constants.O_NOFOLLOW !== 'number') {
      assert.throws(
        () => store.read({ operationId: 'symlink-receipt', tenantId: 'tenant-a' }),
        error => error?.code === 'PROJECT_OPERATION_RECEIPT_UNSAFE_FILESYSTEM'
      );
      return;
    }

    const context = { operationId: 'symlink-receipt', tenantId: 'tenant-a' };
    const receipt = {
      version: 1,
      ...context,
      workspaceId: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64),
      recordedAt: new Date().toISOString(),
      result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
    };
    const receiptPath = store.receiptPath(context.operationId, context.tenantId);
    const targetPath = receiptPath + '.target';
    await fs.writeFile(targetPath, JSON.stringify(receipt), { mode: 0o600 });
    await fs.symlink(targetPath, receiptPath);

    assert.throws(
      () => store.read(context),
      error => error?.code === 'PROJECT_OPERATION_RECEIPT_CORRUPT'
    );
  });
});

test('legacy or stale lock paths fail closed and are never renamed or removed', async () => {
  await withFixture(async ({ store }) => {
    const context = { operationId: 'stale-lock-no-reclaim', tenantId: 'tenant-a' };
    const lockPath = store.receiptPath(context.operationId, context.tenantId) + '.lock';
    const staleMetadata = JSON.stringify({
      token: 'stale-owner-token',
      pid: 2147483647,
      hostname: 'same-host',
      acquiredAt: new Date(0).toISOString()
    });
    await fs.writeFile(lockPath, staleMetadata, { mode: 0o600 });

    assert.throws(
      () => store.write({
        ...context,
        workspaceId: 'a'.repeat(64),
        changeSetHash: 'b'.repeat(64),
        result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
      }),
      error => error?.code === 'PROJECT_OPERATION_RECEIPT_LOCKED'
    );
    assert.equal(await fs.readFile(lockPath, 'utf8'), staleMetadata);
    assert.deepEqual(
      (await fs.readdir(path.dirname(lockPath))).filter(name => name.includes('.stale.')),
      []
    );
  });
});

test('successful receipt writes release only their owned directory lock', async () => {
  await withFixture(async ({ store }) => {
    const context = { operationId: 'directory-lock-release', tenantId: 'tenant-a' };
    const lockPath = store.receiptPath(context.operationId, context.tenantId) + '.lock';
    const receipt = store.write({
      ...context,
      workspaceId: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64),
      result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
    });
    assert.equal(receipt.operationId, context.operationId);
    await assert.rejects(fs.stat(lockPath), error => error?.code === 'ENOENT');
  });
});


test('intent reads preserve filesystem I/O errors instead of misclassifying them as corruption', async () => {
  await withFixture(async ({ store }) => {
    const syncFs = require('node:fs');
    const context = {
      operationId: 'intent-io-error',
      tenantId: 'tenant-a',
      workspaceId: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64)
    };
    store.beginIntent(context);
    const intentPath = store.intentPath(context.operationId, context.tenantId);
    const originalOpenSync = syncFs.openSync;
    const originalReadSync = syncFs.readSync;
    const openError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    syncFs.openSync = function (filePath, ...args) {
      if (filePath === intentPath) throw openError;
      return originalOpenSync.call(this, filePath, ...args);
    };
    try {
      assert.throws(
        () => store.readIntent(context),
        error => error === openError && error.code === 'EACCES'
      );
    } finally {
      syncFs.openSync = originalOpenSync;
    }

    const readError = Object.assign(new Error('storage I/O failure'), { code: 'EIO' });
    syncFs.readSync = function (...args) {
      throw readError;
    };
    try {
      assert.throws(
        () => store.readIntent(context),
        error => error === readError && error.code === 'EIO'
      );
    } finally {
      syncFs.readSync = originalReadSync;
    }
  });
});


test('receipt reads preserve filesystem I/O errors instead of misclassifying them as corruption', async () => {
  await withFixture(async ({ store }) => {
    const syncFs = require('node:fs');
    const context = { operationId: 'receipt-io-error', tenantId: 'tenant-a' };
    const receiptPath = store.receiptPath(context.operationId, context.tenantId);
    const originalOpenSync = syncFs.openSync;
    const expected = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    syncFs.openSync = function (filePath, ...args) {
      if (filePath === receiptPath) throw expected;
      return originalOpenSync.call(this, filePath, ...args);
    };
    try {
      assert.throws(
        () => store.read(context),
        error => error === expected && error.code === 'EACCES'
      );
    } finally {
      syncFs.openSync = originalOpenSync;
    }
  });
});


test('receipt storage rejects directories and parents that allow untrusted lock-path replacement', async t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX ownership and directory-mode checks are not available on this platform');
    return;
  }

  const parent = fsSync.mkdtempSync(path.join(os.tmpdir(), 'orient-receipt-directory-policy-'));
  const directory = path.join(parent, 'receipts');
  const validWrite = {
    operationId: 'private-directory-policy',
    tenantId: 'tenant-a',
    workspaceId: 'a'.repeat(64),
    changeSetHash: 'b'.repeat(64),
    result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
  };

  try {
    fsSync.mkdirSync(directory, { mode: 0o700 });
    fsSync.chmodSync(directory, 0o755);
    const exposedDirectoryStore = new ProjectOperationReceiptStore({ directory });

    assert.throws(
      () => exposedDirectoryStore.write(validWrite),
      error => error.code === 'PROJECT_OPERATION_RECEIPT_DIRECTORY_PERMISSIONS_INVALID'
    );

    fsSync.chmodSync(directory, 0o700);
    fsSync.chmodSync(parent, 0o777);
    const untrustedParentStore = new ProjectOperationReceiptStore({
      directory: path.join(parent, 'other-receipts')
    });

    assert.throws(
      () => untrustedParentStore.write({ ...validWrite, operationId: 'untrusted-parent-policy' }),
      error => error.code === 'PROJECT_OPERATION_RECEIPT_PARENT_UNTRUSTED'
    );
  } finally {
    fsSync.chmodSync(parent, 0o700);
    fsSync.rmSync(parent, { recursive: true, force: true });
  }
});


test('receipt storage rejects an attacker-owned sticky ancestor', async t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX ownership and directory-mode checks are not available on this platform');
    return;
  }

  const parent = fsSync.mkdtempSync(path.join(os.tmpdir(), 'orient-receipt-sticky-parent-'));
  const directory = path.join(parent, 'receipts');
  const originalLstatSync = fsSync.lstatSync;
  try {
    fsSync.chmodSync(parent, 0o1777);
    const store = new ProjectOperationReceiptStore({ directory });
    const attackerUid = BigInt(process.getuid()) + 1n;
    fsSync.lstatSync = function (target, ...args) {
      const stats = originalLstatSync.call(this, target, ...args);
      if (path.resolve(String(target)) !== parent) return stats;
      return new Proxy(stats, {
        get(value, property) {
          if (property === 'uid') return attackerUid;
          const result = Reflect.get(value, property, value);
          return typeof result === 'function' ? result.bind(value) : result;
        }
      });
    };

    assert.throws(
      () => store.ensureDirectory(),
      error => error?.code === 'PROJECT_OPERATION_RECEIPT_PARENT_UNTRUSTED'
    );
  } finally {
    fsSync.lstatSync = originalLstatSync;
    fsSync.chmodSync(parent, 0o700);
    fsSync.rmSync(parent, { recursive: true, force: true });
  }
});

test('receipt storage rejects a writable non-sticky grandparent even when its child is private', async t => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('POSIX ownership and directory-mode checks are not available on this platform');
    return;
  }

  const grandparent = fsSync.mkdtempSync(path.join(os.tmpdir(), 'orient-receipt-grandparent-'));
  const parent = path.join(grandparent, 'private-parent');
  const directory = path.join(parent, 'receipts');
  try {
    fsSync.mkdirSync(parent, { mode: 0o700 });
    fsSync.chmodSync(grandparent, 0o777);
    const store = new ProjectOperationReceiptStore({ directory });

    assert.throws(
      () => store.ensureDirectory(),
      error => error?.code === 'PROJECT_OPERATION_RECEIPT_PARENT_UNTRUSTED'
    );
  } finally {
    fsSync.chmodSync(grandparent, 0o700);
    fsSync.rmSync(grandparent, { recursive: true, force: true });
  }
});

test('receipt storage rejects symbolic-link path ancestors before creating descendants', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX symbolic-link directory setup is required for this test');
    return;
  }

  const parent = fsSync.mkdtempSync(path.join(os.tmpdir(), 'orient-receipt-path-symlink-'));
  const realDirectory = path.join(parent, 'real');
  const linkedDirectory = path.join(parent, 'linked');
  try {
    fsSync.mkdirSync(realDirectory, { mode: 0o700 });
    fsSync.symlinkSync(realDirectory, linkedDirectory, 'dir');
    const store = new ProjectOperationReceiptStore({
      directory: path.join(linkedDirectory, 'receipts')
    });

    assert.throws(
      () => store.ensureDirectory(),
      error => error?.code === 'PROJECT_OPERATION_RECEIPT_DIRECTORY_INVALID'
    );
    assert.equal(fsSync.existsSync(path.join(realDirectory, 'receipts')), false);
  } finally {
    fsSync.rmSync(parent, { recursive: true, force: true });
  }
});

test('filesystem root cannot be configured as receipt storage', () => {
  const root = path.parse(path.resolve(path.sep)).root;
  const store = new ProjectOperationReceiptStore({ directory: root });
  assert.throws(
    () => store.ensureDirectory(),
    error => error?.code === 'PROJECT_OPERATION_RECEIPT_DIRECTORY_INVALID'
  );
});

test('concurrent receipt writers cannot enter a lock directory already owned by another process', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX child-process lock synchronization is required for this adversarial test');
    return;
  }
  await withFixture(async ({ store }) => {
    store.ensureDirectory();
    const input = receiptInput('concurrent-writer');
    const childCode = `
      const fs = require('node:fs');
      const Store = require('./src/infrastructure/execution/project-operation-receipt-store');
      const originalWriteFileSync = fs.writeFileSync;
      let paused = false;
      fs.writeFileSync = function (target, ...args) {
        if (typeof target === 'number' && !paused) {
          paused = true;
          fs.writeSync(1, 'LOCK_HELD\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
        }
        return originalWriteFileSync.call(this, target, ...args);
      };
      const store = new Store({ directory: process.argv[1] });
      store.write({
        operationId: 'concurrent-writer',
        tenantId: 'tenant-a',
        workspaceId: '${'a'.repeat(64)}',
        changeSetHash: '${'b'.repeat(64)}',
        result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
      });
      fs.writeSync(1, 'CHILD_DONE\\n');
    `;
    const child = spawn(process.execPath, ['-e', childCode, store.directory], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitForChildOutput(child, 'LOCK_HELD');
      assert.throws(
        () => store.write(input),
        error => error?.code === 'PROJECT_OPERATION_RECEIPT_LOCKED'
      );
      const exit = await waitForChildExit(child);
      assert.equal(exit.code, 0, 'the lock owner must complete normally');
      assert.ok(store.read(input), 'the winning process must leave a durable receipt');
      assert.doesNotThrow(() => store.write(input), 'a later writer may proceed after the owner releases the lock');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
      }
    }
  });
});

test('owner-marker cleanup cannot admit a successor before the lock directory is removed', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX child-process lock synchronization is required for this adversarial test');
    return;
  }
  await withFixture(async ({ store }) => {
    store.ensureDirectory();
    const input = receiptInput('owner-cleanup-race');
    const childCode = `
      const fs = require('node:fs');
      const Store = require('./src/infrastructure/execution/project-operation-receipt-store');
      const originalUnlinkSync = fs.unlinkSync;
      let paused = false;
      fs.unlinkSync = function (target, ...args) {
        const result = originalUnlinkSync.call(this, target, ...args);
        if (!paused && /owner\\.[^/]+\\.json$/.test(String(target))) {
          paused = true;
          fs.writeSync(1, 'OWNER_MARKER_REMOVED\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
        }
        return result;
      };
      const store = new Store({ directory: process.argv[1] });
      store.write({
        operationId: 'owner-cleanup-race',
        tenantId: 'tenant-a',
        workspaceId: '${'a'.repeat(64)}',
        changeSetHash: '${'b'.repeat(64)}',
        result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
      });
      fs.writeSync(1, 'CHILD_DONE\\n');
    `;
    const child = spawn(process.execPath, ['-e', childCode, store.directory], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const lockPath = store.receiptPath(input.operationId, input.tenantId) + '.lock';
    try {
      await waitForChildOutput(child, 'OWNER_MARKER_REMOVED');
      assert.equal(fsSync.existsSync(lockPath), true, 'the lock directory remains the serialization primitive during cleanup');
      assert.throws(
        () => store.write(input),
        error => error?.code === 'PROJECT_OPERATION_RECEIPT_LOCKED'
      );
      const exit = await waitForChildExit(child);
      assert.equal(exit.code, 0);
      assert.equal(fsSync.existsSync(lockPath), false, 'the owner removes its directory only after marker cleanup');
      assert.doesNotThrow(() => store.write(input), 'a successor may proceed only after rmdir completes');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
      }
    }
  });
});

test('a process crash after lock-directory creation but before owner-marker durability leaves a fail-closed orphan', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX child-process crash semantics are required for this adversarial test');
    return;
  }
  await withFixture(async ({ store }) => {
    store.ensureDirectory();
    const input = receiptInput('crash-before-owner-marker');
    const childCode = `
      const fs = require('node:fs');
      const Store = require('./src/infrastructure/execution/project-operation-receipt-store');
      const originalOpenSync = fs.openSync;
      fs.openSync = function (target, ...args) {
        if (/\\.lock\\/owner\\.[^/]+\\.json$/.test(String(target))) {
          fs.writeSync(1, 'LOCK_DIRECTORY_CREATED\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
        }
        return originalOpenSync.call(this, target, ...args);
      };
      const store = new Store({ directory: process.argv[1] });
      store.write({
        operationId: 'crash-before-owner-marker',
        tenantId: 'tenant-a',
        workspaceId: '${'a'.repeat(64)}',
        changeSetHash: '${'b'.repeat(64)}',
        result: { status: 'verified', verification: { status: 'passed', failed: 0 } }
      });
    `;
    const child = spawn(process.execPath, ['-e', childCode, store.directory], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitForChildOutput(child, 'LOCK_DIRECTORY_CREATED');
      child.kill('SIGKILL');
      const exit = await waitForChildExit(child);
      assert.equal(exit.signal, 'SIGKILL');
      const lockPath = store.receiptPath(input.operationId, input.tenantId) + '.lock';
      assert.equal(fsSync.statSync(lockPath).isDirectory(), true);
      assert.deepEqual(fsSync.readdirSync(lockPath), [], 'the crash point leaves an empty lock directory, not a reclaimable owner');
      assert.throws(
        () => store.write(input),
        error => error?.code === 'PROJECT_OPERATION_RECEIPT_LOCKED'
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
      }
    }
  });
});

