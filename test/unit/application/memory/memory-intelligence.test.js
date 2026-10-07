const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-'));
  const repository = new JsonMemoryRepository(path.join(directory, 'memories.json'));
  const audit = new MemoryAuditRepository(path.join(directory, 'memory-audit.json'));

  return {
    directory,
    service: new MemoryService(repository, audit),
    repository,
    audit
  };
}

test('memory preserves provenance, temporal semantics and confidence', () => {
  const { service } = createService();

  const memory = service.add('I prefer Carrier air conditioners', {
    type: 'preference',
    confidence: 0.91,
    importance: 0.8,
    semanticKey: 'user.preference.hvac.brand',
    source: {
      type: 'user',
      ref: 'conversation:1'
    },
    validFrom: '2026-01-01T00:00:00.000Z',
    tags: ['hvac', 'preference']
  });

  assert.equal(memory.type, 'preference');
  assert.equal(memory.confidence, 0.91);
  assert.equal(memory.source.type, 'user');
  assert.equal(memory.semanticKey, 'user.preference.hvac.brand');
  assert.equal(memory.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(memory.evidence.length, 0);
});

test('exact duplicate reinforces confidence instead of creating duplicate memory', () => {
  const { service, repository } = createService();

  const first = service.add('The user prefers concise answers', {
    type: 'preference',
    confidence: 0.6,
    source: { type: 'user' }
  });

  const second = service.add('The user prefers concise answers', {
    type: 'preference',
    confidence: 0.95,
    source: { type: 'user' }
  });

  assert.equal(second.id, first.id);
  assert.equal(repository.findAll({ tenantId: 'default' }).length, 1);
  assert.equal(second.confidence, 0.95);
});

test('semantic conflicts supersede the previous active fact', () => {
  const { service } = createService();

  const oldMemory = service.add('Preferred city is Alexandria', {
    type: 'fact',
    semanticKey: 'user.home.city',
    source: { type: 'user' }
  });

  const newMemory = service.add('Preferred city is Cairo', {
    type: 'fact',
    semanticKey: 'user.home.city',
    source: { type: 'user' }
  });

  assert.equal(newMemory.supersedesId, oldMemory.id);
  assert.equal(service.get(oldMemory.id).state, 'superseded');
  assert.equal(service.search('Cairo')[0].id, newMemory.id);
});

test('tenant isolation prevents cross-tenant reads and updates', () => {
  const { service } = createService();

  const tenantA = service.add('Tenant A fact', {
    tenantId: 'tenant-a',
    type: 'fact'
  });

  service.add('Tenant B fact', {
    tenantId: 'tenant-b',
    type: 'fact'
  });

  assert.equal(service.get(tenantA.id, { tenantId: 'tenant-a' }).text, 'Tenant A fact');
  assert.throws(
    () => service.get(tenantA.id, { tenantId: 'tenant-b' }),
    error => error.code === 'MEMORY_NOT_FOUND'
  );
});

test('relevance ranking combines lexical match, confidence and importance', () => {
  const { service } = createService();

  const weak = service.add('Python is useful', {
    type: 'fact',
    confidence: 0.2,
    importance: 0.2
  });

  const strong = service.add('Python is useful for ORIENT ONE tooling', {
    type: 'fact',
    confidence: 0.95,
    importance: 0.95
  });

  const results = service.search('Python ORIENT ONE');
  assert.equal(results[0].id, strong.id);
  assert.ok(results[0].relevance > 0);
  assert.notEqual(results[0].id, weak.id);
});

test('consolidation is loss-minimizing and auditable', () => {
  const { service, repository, audit } = createService();

  const first = service.add('User likes quiet environments', {
    type: 'preference',
    confidence: 0.7
  });

  const second = repository.insert({
    ...first,
    id: require('crypto').randomUUID(),
    confidence: 0.9,
    evidence: [{
      kind: 'confirmation',
      source: { type: 'user' },
      capturedAt: new Date().toISOString(),
      confidence: 0.9
    }]
  });

  const result = service.consolidate();
  assert.equal(result.consolidated, 1);
  assert.throws(\n    () => service.get(first.id),\n    error => error.code === 'MEMORY_NOT_FOUND'\n  );
  assert.ok(audit.read().some(event => event.action === 'memory.consolidated'));
});


test('temporal validity excludes expired memories from active recall', () => {
  const { service } = createService();

  const expired = service.add('Old project deadline', {
    type: 'task',
    validUntil: '2020-01-01T00:00:00.000Z'
  });

  service.add('Current project deadline', {
    type: 'task'
  });

  const results = service.search('project deadline');
  assert.equal(results.some(memory => memory.id === expired.id), false);
  assert.equal(results.length, 1);
});


test('archiving a memory preserves the record and writes an audit event', () => {
  const { service, audit } = createService();

  const memory = service.add('Temporary note', { type: 'note' });
  service.forget(memory.id, { reason: 'retention-policy' });

  assert.throws(
    () => service.get(memory.id),
    error => error.code === 'MEMORY_NOT_FOUND'
  );
  assert.ok(
    audit.read().some(event =>
      event.action === 'memory.archived' &&
      event.memoryId === memory.id &&
      event.reason === 'retention-policy'
    )
  );
});
