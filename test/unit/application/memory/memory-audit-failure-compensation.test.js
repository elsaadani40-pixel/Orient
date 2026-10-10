const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-audit-failure-'));
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

test('memory.add compensates the committed insert when the created audit append throws', () => {
  const fixture = createFixture();
  try {
    const originalAppend = fixture.audit.append.bind(fixture.audit);
    fixture.audit.append = event => {
      if (event.action === 'memory.created') {
        throw new Error('injected audit append failure');
      }
      return originalAppend(event);
    };

    assert.throws(
      () => fixture.service.add('must not remain after reported failure', { type: 'note' }, fixture.context),
      error => error.code === 'INVALID_MEMORY' && /injected audit append failure/.test(error.message)
    );

    assert.equal(
      fixture.repository.findAll('tenant-a', 'personal').some(memory =>
        memory.text === 'must not remain after reported failure'
      ),
      false,
      'a failed add must not leave the newly inserted memory behind on the handled exception path'
    );
  } finally {
    fixture.cleanup();
  }
});

test('memory.delete restores the prior active state when the archive audit append throws', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.service.add('restore me when audit fails', { type: 'note' }, fixture.context);
    const originalAppend = fixture.audit.append.bind(fixture.audit);
    fixture.audit.append = event => {
      if (event.action === 'memory.archived') {
        throw new Error('injected archive audit failure');
      }
      return originalAppend(event);
    };

    assert.throws(
      () => fixture.service.delete(memory.id, fixture.context),
      /injected archive audit failure/
    );

    const persisted = fixture.repository.findById(memory.id, 'tenant-a', 'personal');
    assert.equal(persisted.state, 'active');
    assert.equal(persisted.updatedAt, memory.updatedAt);
  } finally {
    fixture.cleanup();
  }
});
