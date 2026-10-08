const test = require('node:test');
const assert = require('node:assert/strict');

const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');
const MemoryAccessPolicy = require('../../../../src/core/memory/memory-access-policy');

function policy() {
  const registry = new AgentRegistry();
  registry.register(new AgentDefinition({
    id: 'research',
    capabilities: ['memory.read'],
    allowedMemoryScopes: ['research']
  }));
  registry.register(new AgentDefinition({
    id: 'writer',
    allowedMemoryScopes: ['writing']
  }));
  return new MemoryAccessPolicy({ agentRegistry: registry });
}

test('MemoryAccessPolicy allows an agent to access a declared scope', () => {
  assert.deepEqual(
    policy().authorize({
      agentId: 'research',
      scope: 'research',
      operation: 'read'
    }),
    {
      allowed: true,
      agentId: 'research',
      scope: 'research',
      operation: 'read'
    }
  );
});

test('MemoryAccessPolicy denies an undeclared scope', () => {
  assert.throws(
    () => policy().authorize({
      agentId: 'writer',
      scope: 'research',
      operation: 'read'
    }),
    error => error.code === 'MEMORY_SCOPE_FORBIDDEN'
  );
});

test('MemoryAccessPolicy denies writes outside the declared scope', () => {
  assert.throws(
    () => policy().authorize({
      agentId: 'writer',
      scope: 'research',
      operation: 'write'
    }),
    error => error.code === 'MEMORY_SCOPE_FORBIDDEN'
  );
});

test('MemoryAccessPolicy denies deletes outside the declared scope', () => {
  assert.throws(
    () => policy().authorize({
      agentId: 'writer',
      scope: 'research',
      operation: 'delete'
    }),
    error => error.code === 'MEMORY_SCOPE_FORBIDDEN'
  );
});


test('MemoryAccessPolicy denies an operation without the matching capability', () => {
  const registry = new AgentRegistry();
  registry.register(new AgentDefinition({
    id: 'read-only',
    capabilities: ['memory.read'],
    allowedMemoryScopes: ['research']
  }));

  const policy = new MemoryAccessPolicy({ agentRegistry: registry });

  assert.throws(
    () => policy.authorize({
      agentId: 'read-only',
      scope: 'research',
      operation: 'write'
    }),
    error => error.code === 'MEMORY_OPERATION_FORBIDDEN'
  );
});

test('MemoryAccessPolicy requires the exact capability for each operation', () => {
  const registry = new AgentRegistry();
  registry.register(new AgentDefinition({
    id: 'writer',
    capabilities: ['memory.write'],
    allowedMemoryScopes: ['research']
  }));

  const policy = new MemoryAccessPolicy({ agentRegistry: registry });

  assert.throws(
    () => policy.authorize({
      agentId: 'writer',
      scope: 'research',
      operation: 'read'
    }),
    error => error.code === 'MEMORY_OPERATION_FORBIDDEN'
  );

  assert.deepEqual(
    policy.authorize({
      agentId: 'writer',
      scope: 'research',
      operation: 'write'
    }),
    {
      allowed: true,
      agentId: 'writer',
      scope: 'research',
      operation: 'write',
      capability: 'memory.write'
    }
  );
});
