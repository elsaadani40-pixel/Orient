'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createMemoryTools = require('../../../../src/application/tools/memory.tools');

test('memory tools declare read effects and conservative mutation idempotency', () => {
  const memoryService = {
    list: () => [],
    add: async () => ({ ok: true }),
    delete: async () => ({ ok: true }),
    history: () => []
  };

  const tools = createMemoryTools(memoryService);
  const declarations = Object.fromEntries(
    tools.map(({ name, effects, idempotency }) => [
      name,
      { effects, idempotency }
    ])
  );

  assert.deepEqual(declarations, {
    'memory.search': { effects: 'read_only', idempotency: 'idempotent' },
    'memory.list': { effects: 'read_only', idempotency: 'idempotent' },
    'memory.add': { effects: 'local_mutation', idempotency: 'unknown' },
    'memory.delete': { effects: 'local_mutation', idempotency: 'unknown' },
    'memory.history': { effects: 'read_only', idempotency: 'idempotent' }
  });
});
