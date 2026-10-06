const test = require('node:test');
const assert = require('node:assert/strict');

const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');
const MemoryAccessPolicy = require('../../../../src/core/memory/memory-access-policy');
const MemoryService = require('../../../../src/application/memory/memory.service');

function makeService() {
  const records = [];
  const repository = {
    findAll: tenantId => records.filter(item => item.tenantId === tenantId),
    findById: (id, tenantId) => records.find(item => item.id === id && item.tenantId === tenantId) || null,
    insert: (memory, tenantId) => {
      const stored = { ...memory, tenantId };
      records.push(stored);
      return stored;
    },
    deleteById: (id, tenantId) => {
      const index = records.findIndex(item => item.id === id && item.tenantId === tenantId);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    }
  };

  const registry = new AgentRegistry();
  registry.register(new AgentDefinition({
    id: 'research',
    allowedMemoryScopes: ['research']
  }));
  registry.register(new AgentDefinition({
    id: 'writer',
    allowedMemoryScopes: ['writing']
  }));

  const policy = new MemoryAccessPolicy({ agentRegistry: registry });
  const service = new MemoryService(repository, {
    memoryAccessPolicy: policy,
    defaultScope: 'research'
  });

  return { service, records };
}

test('MemoryService enforces agent scope on writes', () => {
  const { service } = makeService();

  assert.throws(
    () => service.add('secret', {}, {
      agentId: 'writer',
      memoryScope: 'research',
      tenantId: 'tenant-a'
    }),
    error => error.code === 'MEMORY_SCOPE_FORBIDDEN'
  );
});

test('MemoryService keeps tenant memory isolated', () => {
  const { service } = makeService();

  service.add('tenant A memory', {}, {
    agentId: 'research',
    memoryScope: 'research',
    tenantId: 'tenant-a'
  });

  service.add('tenant B memory', {}, {
    agentId: 'research',
    memoryScope: 'research',
    tenantId: 'tenant-b'
  });

  assert.equal(
    service.list('', {
      agentId: 'research',
      memoryScope: 'research',
      tenantId: 'tenant-a'
    }).length,
    1
  );

  assert.equal(
    service.list('', {
      agentId: 'research',
      memoryScope: 'research',
      tenantId: 'tenant-b'
    }).length,
    1
  );

  assert.equal(
    service.list('', {
      agentId: 'research',
      memoryScope: 'research',
      tenantId: 'tenant-a'
    })[0].text,
    'tenant A memory'
  );
});
