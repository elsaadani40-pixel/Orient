const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WorkflowRepository = require('../../../../../src/infrastructure/persistence/json/workflow.repository');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-workflow-'));
  return {
    dir,
    repo: new WorkflowRepository(path.join(dir, 'workflows.json'))
  };
}

test('workflow repository advances checkpoint revisions atomically', () => {
  const { dir, repo } = makeRepo();
  try {
    const first = {
      workflowId: 'w1',
      tenantId: 'local',
      checkpoint: { revision: 0 },
      toJSON() { return { workflowId: this.workflowId, tenantId: this.tenantId, checkpoint: this.checkpoint }; },
      setCheckpointRevision(revision, savedAt) { this.checkpoint = { revision, lastSavedAt: savedAt }; }
    };

    repo.save(first);
    assert.equal(first.checkpoint.revision, 1);

    repo.save(first);
    assert.equal(first.checkpoint.revision, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale workflow checkpoint is rejected instead of overwriting newer mission state', () => {
  const { dir, repo } = makeRepo();
  try {
    const make = () => ({
      workflowId: 'w2',
      tenantId: 'local',
      checkpoint: { revision: 0 },
      toJSON() { return { workflowId: this.workflowId, tenantId: this.tenantId, checkpoint: this.checkpoint, value: this.value }; },
      setCheckpointRevision(revision, savedAt) { this.checkpoint = { revision, lastSavedAt: savedAt }; }
    });

    const a = make();
    const b = make();
    a.value = 'newer';
    b.value = 'stale';
    repo.save(a);

    assert.throws(() => repo.save(b), { code: 'WORKFLOW_CHECKPOINT_CONFLICT' });
    assert.equal(repo.findById('w2').value, 'newer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('JSON workflow outbox lookup and acknowledgement are tenant-scoped and revisioned', () => {
  const { dir, repo } = makeRepo();
  try {
    repo.save({
      workflowId: 'wf-outbox-a',
      tenantId: 'tenant-a',
      state: 'WAITING',
      updatedAt: '2026-11-09T10:00:00.000Z',
      checkpoint: { revision: 0 },
      metadata: {
        approvalBlocked: true,
        pendingPublications: [{ eventId: 'event-a1' }, { eventId: 'event-a2' }]
      }
    }, 'tenant-a');
    repo.save({
      workflowId: 'wf-outbox-b',
      tenantId: 'tenant-b',
      state: 'WAITING',
      updatedAt: '2026-11-09T10:00:01.000Z',
      checkpoint: { revision: 0 },
      metadata: { approvalBlocked: true, pendingPublications: [{ eventId: 'event-b1' }] }
    }, 'tenant-b');
    assert.deepEqual(
      repo.findPendingPublications({ tenantId: 'tenant-a', limit: 1 }).map(item => item.workflowId),
      ['wf-outbox-a']
    );
    const result = repo.acknowledgePendingPublications('wf-outbox-a', 'tenant-a', ['event-a1']);
    assert.equal(result.acknowledged, 1);
    assert.equal(result.revision, 2);
    assert.deepEqual(result.pending, [{ eventId: 'event-a2' }]);
    assert.throws(
      () => repo.acknowledgePendingPublications('wf-outbox-a', 'tenant-b', ['event-a2']),
      error => error.code === 'WORKFLOW_NOT_FOUND'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
