const test = require('node:test');
const assert = require('node:assert/strict');

const ToolInterface = require('../../../../src/core/tools/tool.interface');

test('ToolInterface preserves legacy construction and exposes security metadata', () => {
  const tool = new ToolInterface({
    name: 'demo',
    description: 'demo tool',
    execute: async () => ({ ok: true })
  });

  assert.equal(tool.name, 'demo');
  assert.equal(tool.retryable, false);
  assert.deepEqual(tool.capabilities, []);
  assert.equal(tool.risk, null);
  assert.equal(tool.sandbox, null);
});

test('ToolInterface normalizes capability and sandbox metadata', () => {
  const tool = new ToolInterface({
    name: 'shell',
    execute: async () => ({ ok: true }),
    capabilities: ['filesystem.write', 'filesystem.write', '', 'shell.execute'],
    risk: 'sensitive',
    sandbox: {
      required: true,
      profile: 'restricted-process'
    }
  });

  assert.deepEqual(tool.capabilities, [
    'filesystem.write',
    'shell.execute'
  ]);
  assert.equal(tool.risk, 'sensitive');
  assert.deepEqual(tool.sandbox, {
    required: true,
    profile: 'restricted-process'
  });
});

test('ToolInterface rejects malformed capability metadata', () => {
  assert.throws(
    () => new ToolInterface({
      name: 'invalid',
      execute: async () => null,
      capabilities: 'shell.execute'
    }),
    /capabilities must be an array/
  );
});


test('ToolInterface security metadata is immutable', () => {
  const tool = new ToolInterface({
    name: 'secure',
    execute: async () => ({ ok: true }),
    capabilities: ['safe.read'],
    risk: 'high',
    sandbox: { required: true, profile: 'restricted-process' }
  });

  assert.equal(Object.isFrozen(tool), true);
  assert.equal(Object.isFrozen(tool.capabilities), true);
  assert.equal(tool.risk, 'high');
  assert.throws(() => Object.defineProperty(tool, 'risk', { value: 'low' }), TypeError);
  assert.throws(() => Object.defineProperty(tool, 'capabilities', { value: ['*'] }), TypeError);
});
