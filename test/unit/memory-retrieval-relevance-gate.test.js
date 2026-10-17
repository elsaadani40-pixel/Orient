'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryService = require('../../src/application/memory/memory.service');
const { createMemory } = require('../../src/domain/memory/memory.entity');

function createService(records) {
  const repository = {
    findAll(tenantId, scope) {
      return records.filter(record =>
        record.tenantId === tenantId && record.scope === scope
      );
    }
  };
  return new MemoryService(repository);
}

test('search does not return unrelated memories just because they are recent or important', () => {
  const relevant = createMemory({
    text: 'The owner prefers Arabic responses',
    type: 'preference',
    importance: 1,
    confidence: 1,
    tenantId: 'tenant-a',
    scope: 'personal'
  });
  const unrelated = createMemory({
    text: 'The refrigerator compressor was replaced',
    type: 'note',
    importance: 1,
    confidence: 1,
    tenantId: 'tenant-a',
    scope: 'personal'
  });

  const service = createService([relevant, unrelated]);
  const results = service.search('Arabic language', {
    tenantId: 'tenant-a',
    memoryScope: 'personal'
  });

  assert.deepEqual(results.map(memory => memory.id), [relevant.id]);
  assert.ok(results[0].relevance > 0);
});

test('search returns no results when no active memory matches any query token', () => {
  const service = createService([
    createMemory({
      text: 'Schedule a routine maintenance visit',
      tenantId: 'tenant-a',
      scope: 'personal'
    })
  ]);

  assert.deepEqual(
    service.search('unrelated astronomy topic', {
      tenantId: 'tenant-a',
      memoryScope: 'personal'
    }),
    []
  );
});

test('search remains tenant- and scope-scoped while applying the relevance gate', () => {
  const own = createMemory({
    text: 'Project ORIENT uses a local runtime',
    tenantId: 'tenant-a',
    scope: 'personal'
  });
  const otherTenant = createMemory({
    text: 'Project ORIENT has local runtime',
    tenantId: 'tenant-b',
    scope: 'personal'
  });
  const otherScope = createMemory({
    text: 'Project ORIENT uses a local runtime',
    tenantId: 'tenant-a',
    scope: 'work'
  });

  const service = createService([own, otherTenant, otherScope]);
  const results = service.search('ORIENT runtime', {
    tenantId: 'tenant-a',
    memoryScope: 'personal'
  });

  assert.deepEqual(results.map(memory => memory.id), [own.id]);
});
