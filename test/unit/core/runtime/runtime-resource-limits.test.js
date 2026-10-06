const test = require('node:test');
const assert = require('node:assert/strict');

const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');

test('runtime rejects oversized input before orchestration', async () => {
  const runtime = new OrientRuntime({
    toolRegistry: { get() { return null; } },
    agentOrchestrator: {},
    maxInputChars: 4
  });

  const result = await runtime.execute('12345');

  assert.equal(result.code, 'INPUT_TOO_LARGE');
  assert.equal(result.type, 'error');
});
