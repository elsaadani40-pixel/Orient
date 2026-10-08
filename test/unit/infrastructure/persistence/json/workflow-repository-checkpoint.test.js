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
