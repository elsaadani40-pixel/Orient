const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-conflict-'));
  const repository = new JsonMemoryRepository(path.join(directory, 'memories.json'));
  const audit = new MemoryAuditRepository(path.join(directory, 'audit.json'));
  const service = new MemoryService(repository, { auditRepository: audit });
  const context = { agentId: 'ORIENT_RUNTIME', tenantId: 'tenant-a' };
  return {
    repository, audit, service, context,
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

test('memory.add restores the superseded record when inserting the conflict winner fails', () => {
  const fixture = createFixture();
  try {
    const existing = fixture.service.add('older conflicting fact', {
      type: 'note',
      semanticKey: 'customer-status',
      confidence: 0.4
    }, fixture.context);
    const original = fixture.repository.findById(existing.id, 'tenant-a', 'personal');
    const originalInsert = fixture.repository.insert.bind(fixture.repository);
    fixture.repository.insert = () => {
      throw new Error('injected candidate insert failure');
    };

    assert.throws(
      () => fixture.service.add('newer conflicting fact', {
        type: 'note',
        semanticKey: 'customer-status',
        confidence: 0.99
      }, fixture.context),
      /injected candidate insert failure/
    );

    const restored = fixture.repository.findById(existing.id, 'tenant-a', 'personal');
    assert.equal(restored.state, original.state);
    assert.equal(restored.supersededById, original.supersededById);
    assert.equal(restored.updatedAt, original.updatedAt);
    fixture.repository.insert = originalInsert;
    assert.equal(fixture.repository.findAll('tenant-a', 'personal').length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('memory.add rolls back conflict changes when the conflict audit append fails', () => {
  const fixture = createFixture();
  try {
    const existing = fixture.service.add('existing conflicting fact', {
      type: 'note',
      semanticKey: 'contract-status',
      confidence: 0.3
    }, fixture.context);
    const original = fixture.repository.findById(existing.id, 'tenant-a', 'personal');
    const originalAppend = fixture.audit.append.bind(fixture.audit);
    fixture.audit.append = event => {
      if (event.action === 'memory.conflict.resolved') {
        throw new Error('injected conflict audit failure');
      }
      return originalAppend(event);
    };

    assert.throws(
      () => fixture.service.add('candidate conflicting fact', {
        type: 'note',
        semanticKey: 'contract-status',
        confidence: 0.99
      }, fixture.context),
      error => error.code === 'INVALID_MEMORY' && /injected conflict audit failure/.test(error.message)
    );

    const restored = fixture.repository.findById(existing.id, 'tenant-a', 'personal');
    assert.equal(restored.state, original.state);
    assert.equal(restored.supersededById, original.supersededById);
    assert.equal(restored.updatedAt, original.updatedAt);
    assert.equal(fixture.repository.findAll('tenant-a', 'personal').length, 1);
  } finally {
    fixture.cleanup();
  }
});
