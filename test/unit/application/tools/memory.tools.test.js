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


test('memory tools await asynchronous repository-backed service operations', async () => {
  const expected = {
    list: [{ id: 'memory-1' }],
    add: { id: 'memory-2' },
    delete: true,
    history: [{ action: 'memory.created' }],
    reconcile: { status: 'committed' }
  };
  const memoryService = {
    list: async () => expected.list,
    add: async () => expected.add,
    delete: async () => expected.delete,
    history: async () => expected.history,
    reconcileToolOperation: async () => expected.reconcile
  };
  const tools = Object.fromEntries(
    createMemoryTools(memoryService).map(tool => [tool.name, tool])
  );

  assert.deepEqual(
    (await tools['memory.search'].execute('query', {})).memories,
    expected.list
  );
  assert.deepEqual(
    (await tools['memory.list'].execute('', {})).memories,
    expected.list
  );
  assert.deepEqual(
    await tools['memory.add'].execute({ text: 'new memory' }, {}),
    expected.add
  );
  assert.equal(await tools['memory.delete'].execute('memory-2', {}), true);
  assert.deepEqual(
    (await tools['memory.history'].execute('memory-2', {})).history,
    expected.history
  );
  assert.deepEqual(
    await tools['memory.add'].reconcile({ text: 'new memory' }, {}),
    expected.reconcile
  );
  assert.deepEqual(
    await tools['memory.delete'].reconcile('memory-2', {}),
    expected.reconcile
  );
});
