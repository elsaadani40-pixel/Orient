const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');
const MemoryService = require('../../../../src/application/memory/memory.service');

function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-'));
  const repository = new JsonMemoryRepository(path.join(directory, 'memories.json'));
  const audit = new MemoryAuditRepository(path.join(directory, 'memory-audit.json'));
  const service = new MemoryService(repository, {
    auditRepository: audit,
    defaultScope: 'personal'
  });
  const context = { agentId: 'ORIENT_RUNTIME', tenantId: 'default' };
  return { directory, service, repository, audit, context };
}

test('memory preserves provenance, temporal semantics, confidence and scope', () => {
  const { service, context } = createService();
  const memory = service.add('I prefer Carrier air conditioners', {
    type: 'preference',
    confidence: 0.91,
    importance: 0.8,
    semanticKey: 'user.preference.hvac.brand',
    source: { type: 'user', ref: 'conversation:1' },
    validFrom: '2026-01-01T00:00:00.000Z',
    tags: ['hvac', 'preference']
  }, context);

  assert.equal(memory.type, 'preference');
  assert.equal(memory.confidence, 0.91);
  assert.equal(memory.source.type, 'user');
  assert.equal(memory.semanticKey, 'user.preference.hvac.brand');
  assert.equal(memory.scope, 'personal');
  assert.equal(memory.validFrom, '2026-01-01T00:00:00.000Z');
});

test('exact duplicate reinforces confidence without creating a duplicate', () => {
  const { service, repository, context } = createService();
  const first = service.add('The user prefers concise answers', {
    type: 'preference', confidence: 0.6, source: { type: 'user' }
  }, context);
  const second = service.add('The user prefers concise answers', {
    type: 'preference', confidence: 0.95, source: { type: 'user' }
  }, context);

  assert.equal(second.id, first.id);
  assert.equal(repository.findAll('default', 'personal').length, 1);
  assert.equal(second.confidence, 0.95);
});

test('semantic conflicts supersede the previous active fact', () => {
  const { service, context } = createService();
  const oldMemory = service.add('Preferred city is Alexandria', {
    type: 'fact', semanticKey: 'user.home.city', source: { type: 'user' }
  }, context);
  const newMemory = service.add('Preferred city is Cairo', {
    type: 'fact', semanticKey: 'user.home.city', source: { type: 'user' }
  }, context);

  assert.equal(newMemory.supersedesId, oldMemory.id);
  assert.throws(
    () => service.get(oldMemory.id, context),
    error => error.code === 'MEMORY_NOT_FOUND'
  );
  assert.equal(service.search('Cairo', context)[0].id, newMemory.id);
});

test('tenant and scope isolation prevent cross-boundary reads and updates', () => {
  const { service, repository } = createService();
  const a = { agentId: 'ORIENT_RUNTIME', tenantId: 'tenant-a' };
  const b = { agentId: 'ORIENT_RUNTIME', tenantId: 'tenant-b' };

  const tenantA = service.add('Tenant A fact', { type: 'fact' }, a);
  const tenantB = service.add('Tenant B fact', { type: 'fact' }, b);

  assert.equal(service.get(tenantA.id, a).text, 'Tenant A fact');
  assert.throws(
    () => service.get(tenantA.id, b),
    error => error.code === 'MEMORY_NOT_FOUND'
  );

  assert.equal(repository.findById(tenantA.id, 'tenant-a', 'personal').text, 'Tenant A fact');
  assert.equal(repository.findById(tenantB.id, 'tenant-b', 'personal').text, 'Tenant B fact');
});

test('missing tenant context is denied fail-closed', () => {
  const { service } = createService();
  assert.throws(
    () => service.list('anything'),
    error => error.code === 'MEMORY_TENANT_REQUIRED'
  );
});

test('relevance ranking combines lexical match, confidence and importance', () => {
  const { service, context } = createService();
  const weak = service.add('Python is useful', {
    type: 'fact', confidence: 0.2, importance: 0.2
  }, context);
  const strong = service.add('Python is useful for ORIENT ONE tooling', {
    type: 'fact', confidence: 0.95, importance: 0.95
  }, context);

  const results = service.search('Python ORIENT ONE', context);
  assert.equal(results[0].id, strong.id);
  assert.ok(results[0].relevance > 0);
  assert.notEqual(results[0].id, weak.id);
});

test('temporal validity excludes expired memories from active recall', () => {
  const { service, context } = createService();
  const expired = service.add('Old project deadline', {
    type: 'task', validUntil: '2020-01-01T00:00:00.000Z'
  }, context);
  service.add('Current project deadline', { type: 'task' }, context);

  const results = service.search('project deadline', context);
  assert.equal(results.some(memory => memory.id === expired.id), false);
  assert.equal(results.length, 1);
});

test('consolidation is loss-minimizing and auditable', () => {
  const { service, repository, audit, context } = createService();
  const first = service.add('User likes quiet environments', {
    type: 'preference', confidence: 0.7
  }, context);
  const second = repository.insert({
    ...first,
    id: crypto.randomUUID(),
    confidence: 0.9,
    evidence: [{
      kind: 'confirmation',
      source: { type: 'user' },
      capturedAt: new Date().toISOString(),
      confidence: 0.9
    }]
  }, 'default', 'personal');

  const result = service.consolidate(context);
  assert.equal(result.consolidated, 1);
  assert.throws(
    () => service.get(first.id, context),
    error => error.code === 'MEMORY_NOT_FOUND'
  );
  assert.equal(repository.findById(second.id, 'default', 'personal').state, 'active');
  assert.ok(audit.read().some(event => event.action === 'memory.consolidated'));
});


test('memory audit carries execution and decision trace context', () => {
  const { service, context } = createService();
  const traceContext = {
    ...context,
    executionId: 'exec-42',
    goalId: 'goal-7',
    decisionId: 'decision-9',
    correlationId: 'corr-1',
    traceId: 'trace-1'
  };

  const memory = service.add('Traceable memory', {
    type: 'note',
    source: { type: 'agent', ref: 'decision:decision-9' }
  }, traceContext);

  const history = service.history(memory.id, traceContext);
  const created = history.find(event => event.action === 'memory.created');

  assert.ok(created);
  assert.equal(created.executionId, 'exec-42');
  assert.equal(created.goalId, 'goal-7');
  assert.equal(created.decisionId, 'decision-9');
  assert.equal(created.correlationId, 'corr-1');
  assert.equal(created.traceId, 'trace-1');
  assert.equal(created.agentId, 'ORIENT_RUNTIME');
  assert.equal(created.scope, 'personal');
});

test('memory history cannot cross tenant or scope boundaries', () => {
  const { service, context } = createService();
  const memory = service.add('Private trace', { type: 'note' }, context);

  assert.equal(service.history(memory.id, {
    ...context,
    tenantId: 'other-tenant'
  }).length, 0);

  assert.equal(service.history(memory.id, {
    ...context,
    memoryScope: 'private'
  }).length, 0);
});

test('delete is retention-safe: archive plus audit, not physical removal', () => {
  const { service, repository, audit, context } = createService();
  const memory = service.add('Temporary note', { type: 'note' }, context);

  service.delete(memory.id, { ...context, reason: 'retention-policy' });

  assert.equal(
    repository.findById(memory.id, 'default', 'personal').state,
    'archived'
  );
  assert.throws(
    () => service.get(memory.id, context),
    error => error.code === 'MEMORY_NOT_FOUND'
  );
  assert.ok(audit.read().some(event =>
    event.action === 'memory.archived' &&
    event.memoryId === memory.id &&
    event.reason === 'retention-policy'
  ));
});
