const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-consolidation-'));
  const repository = new JsonMemoryRepository(path.join(directory, 'memories.json'));
  const audit = new MemoryAuditRepository(path.join(directory, 'audit.json'));
  const service = new MemoryService(repository, { auditRepository: audit });
  const context = { agentId: 'ORIENT_RUNTIME', tenantId: 'tenant-a' };

  return {
    repository,
    audit,
    service,
    context,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('memory.consolidate restores all touched records when a later write fails', () => {
  const fixture = createFixture();
  try {
    const first = fixture.service.add('duplicate record', {
      type: 'note',
      confidence: 0.6,
      importance: 0.4
    }, fixture.context);
    const second = fixture.repository.insert({
      ...first,
      id: 'duplicate-record-2',
      confidence: 0.9,
      importance: 0.8,
      evidence: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }, 'tenant-a', 'personal');

    const beforeFirst = fixture.repository.findById(first.id, 'tenant-a', 'personal');
    const beforeSecond = fixture.repository.findById(second.id, 'tenant-a', 'personal');
    const originalUpdate = fixture.repository.update.bind(fixture.repository);
    let updateCalls = 0;
    fixture.repository.update = (...args) => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error('injected second consolidation write failure');
      return originalUpdate(...args);
    };

    assert.throws(
      () => fixture.service.consolidate(fixture.context),
      /injected second consolidation write failure/
    );

    const afterFirst = fixture.repository.findById(first.id, 'tenant-a', 'personal');
    const afterSecond = fixture.repository.findById(second.id, 'tenant-a', 'personal');
    assert.equal(afterFirst.state, beforeFirst.state);
    assert.equal(afterFirst.confidence, beforeFirst.confidence);
    assert.equal(afterFirst.importance, beforeFirst.importance);
    assert.deepEqual(afterFirst.evidence, beforeFirst.evidence);
    assert.equal(afterFirst.updatedAt, beforeFirst.updatedAt);
    assert.equal(afterSecond.state, beforeSecond.state);
    assert.equal(afterSecond.confidence, beforeSecond.confidence);
    assert.equal(afterSecond.importance, beforeSecond.importance);
    assert.deepEqual(afterSecond.evidence, beforeSecond.evidence);
    assert.equal(afterSecond.updatedAt, beforeSecond.updatedAt);
  } finally {
    fixture.cleanup();
  }
});

test('memory.consolidate restores touched records when the final audit append fails', () => {
  const fixture = createFixture();
  try {
    const first = fixture.service.add('audit duplicate', {
      type: 'note',
      confidence: 0.6
    }, fixture.context);
    const second = fixture.repository.insert({
      ...first,
      id: 'audit-duplicate-2',
      confidence: 0.9,
      evidence: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }, 'tenant-a', 'personal');

    const before = [first.id, second.id].map(id =>
      fixture.repository.findById(id, 'tenant-a', 'personal')
    );
    const originalAppend = fixture.audit.append.bind(fixture.audit);
    fixture.audit.append = event => {
      if (event.action === 'memory.consolidated') {
        throw new Error('injected consolidation audit failure');
      }
      return originalAppend(event);
    };

    assert.throws(
      () => fixture.service.consolidate(fixture.context),
      /injected consolidation audit failure/
    );

    for (const snapshot of before) {
      const persisted = fixture.repository.findById(snapshot.id, 'tenant-a', 'personal');
      assert.equal(persisted.state, snapshot.state);
      assert.equal(persisted.confidence, snapshot.confidence);
      assert.equal(persisted.importance, snapshot.importance);
      assert.deepEqual(persisted.evidence, snapshot.evidence);
      assert.equal(persisted.updatedAt, snapshot.updatedAt);
    }
  } finally {
    fixture.cleanup();
  }
});
