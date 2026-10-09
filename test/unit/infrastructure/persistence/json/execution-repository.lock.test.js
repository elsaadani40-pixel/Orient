'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExecutionRepository = require('../../../../../src/infrastructure/persistence/json/execution.repository');

function fixture(lockTimeoutMs = 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-execution-lock-'));
  return {
    dir,
    repository: new ExecutionRepository(path.join(dir, 'executions.json'), { lockTimeoutMs })
  };
}

test('execution repository does not reclaim an old lock owned by a live process', () => {
  const f = fixture(20);
  try {
    fs.mkdirSync(f.repository.lockPath);
    fs.writeFileSync(path.join(f.repository.lockPath, 'owner.json'), JSON.stringify({
      token: 'live-owner',
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(f.repository.lockPath, old, old);

    assert.throws(
      () => f.repository.withLock(() => 'must not run'),
      error => error.code === 'EXECUTION_STORAGE_LOCK_TIMEOUT'
    );
    assert.equal(fs.existsSync(f.repository.lockPath), true);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('execution repository recovers a lock whose local owner process is dead', () => {
  const f = fixture(100);
  try {
    fs.mkdirSync(f.repository.lockPath);
    fs.writeFileSync(path.join(f.repository.lockPath, 'owner.json'), JSON.stringify({
      token: 'dead-owner',
      pid: 2147483647,
      hostname: os.hostname(),
      acquiredAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(f.repository.lockPath, old, old);

    assert.equal(f.repository.withLock(() => 'acquired'), 'acquired');
    assert.equal(fs.existsSync(f.repository.lockPath), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('execution repository releases its lock when the protected operation throws', () => {
  const f = fixture(100);
  try {
    assert.throws(() => f.repository.withLock(() => {
      throw new Error('operation failed');
    }), /operation failed/);
    assert.equal(fs.existsSync(f.repository.lockPath), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
