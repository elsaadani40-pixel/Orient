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


test('async memory tools preserve explicit scope through execution and reconciliation', async () => {
  const calls = [];
  const memoryService = {
    list: async () => [],
    add: async (...args) => { calls.push({ method: 'add', args }); return { ok: true }; },
    delete: async (...args) => { calls.push({ method: 'delete', args }); return true; },
    history: async () => [],
    reconcileToolOperation: async (...args) => { calls.push({ method: 'reconcile', args }); return { status: 'unknown' }; }
  };
  const tools = Object.fromEntries(
    createMemoryTools(memoryService).map(tool => [tool.name, tool])
  );
  const context = { tenantId: 'tenant-a', memoryScope: 'personal' };

  await tools['memory.add'].execute({ text: 'scoped fact', scope: 'project' }, context);
  const addCall = calls.find(call => call.method === 'add');
  assert.equal(addCall.args[1].scope, 'project');
  assert.equal(addCall.args[2].memoryScope, 'project');

  await tools['memory.delete'].execute({ id: 'memory-1', scope: 'project' }, context);
  const deleteCall = calls.find(call => call.method === 'delete');
  assert.equal(deleteCall.args[1].memoryScope, 'project');

  await tools['memory.delete'].reconcile(
    { id: 'memory-1', scope: 'project' },
    { tenantId: 'tenant-a', memoryScope: 'personal' }
  );
  const reconciliationCall = calls.find(call => call.method === 'reconcile');
  assert.equal(reconciliationCall.args[0], 'memory.delete');
  assert.equal(reconciliationCall.args[2].memoryScope, 'project');
});
