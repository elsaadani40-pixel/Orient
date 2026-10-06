const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CheckpointRepository =
  require('../../../src/infrastructure/persistence/json/checkpoint.repository');

test('checkpoint repository stores the latest snapshot and verifies integrity', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-checkpoint-')
  );

  const repository =
    new CheckpointRepository(
      path.join(directory, 'checkpoints.json')
    );

  const first = repository.save({
    executionId: 'exec-1',
    status: 'running',
    currentStep: 1
  }, {
    reason: 'step_completed'
  });

  const second = repository.save({
    executionId: 'exec-1',
    status: 'running',
    currentStep: 2
  }, {
    reason: 'step_completed'
  });

  assert.equal(second.sequence, 2);

  const latest =
    repository.findLatest('exec-1');

  assert.equal(latest.sequence, 2);
  assert.equal(latest.snapshot.currentStep, 2);
  assert.equal(
    latest.snapshotSha256.length,
    64
  );

  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
});

test('checkpoint repository rejects tampered snapshots', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-checkpoint-integrity-')
  );

  const file =
    path.join(directory, 'checkpoints.json');

  const repository =
    new CheckpointRepository(file);

  repository.save({
    executionId: 'exec-2',
    status: 'running',
    currentStep: 1
  });

  const records =
    JSON.parse(fs.readFileSync(file, 'utf8'));

  records['exec-2'].snapshot.currentStep = 99;

  fs.writeFileSync(
    file,
    JSON.stringify(records),
    'utf8'
  );

  assert.throws(
    () => repository.findLatest('exec-2'),
    error =>
      error.code === 'CHECKPOINT_INTEGRITY_FAILED'
  );

  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
});
