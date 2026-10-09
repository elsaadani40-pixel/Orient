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

test('checkpoint saves preserve an active resume lease until its owner releases it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-checkpoint-resume-lease-'));
  const repository = new CheckpointRepository(path.join(directory, 'checkpoints.json'));

  repository.save({
    executionId: 'exec-resume-lease',
    tenantId: 'tenant-a',
    metadata: { tenantId: 'tenant-a' },
    status: 'running',
    currentStep: 1
  }, { tenantId: 'tenant-a', reason: 'step_completed' });

  const lease = repository.acquireResumeLease('exec-resume-lease', {
    tenantId: 'tenant-a',
    leaseDurationMs: 30000
  });
  assert.ok(lease.leaseId);

  repository.save({
    executionId: 'exec-resume-lease',
    tenantId: 'tenant-a',
    metadata: { tenantId: 'tenant-a' },
    status: 'running',
    currentStep: 2
  }, { tenantId: 'tenant-a', reason: 'resume_step_completed' });

  assert.throws(
    () => repository.acquireResumeLease('exec-resume-lease', {
      tenantId: 'tenant-a',
      leaseDurationMs: 30000
    }),
    error => error.code === 'CHECKPOINT_RESUME_LEASE_HELD'
  );

  assert.equal(
    repository.releaseResumeLease('exec-resume-lease', lease.leaseId, { tenantId: 'tenant-a' }),
    true
  );
  assert.ok(repository.acquireResumeLease('exec-resume-lease', {
    tenantId: 'tenant-a',
    leaseDurationMs: 30000
  }).leaseId);

  fs.rmSync(directory, { recursive: true, force: true });
});
