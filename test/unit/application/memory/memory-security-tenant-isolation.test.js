const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');
const MemoryAccessPolicy = require('../../../../src/core/memory/memory-access-policy');
const MemoryService = require('../../../../src/application/memory/memory.service');
const JsonMemoryRepository = require('../../../../src/infrastructure/memory/json-memory.repository');

function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-security-'));
  const repository = new JsonMemoryRepository(path.join(directory, 'memory.json'));
  const agentRegistry = new AgentRegistry();

  agentRegistry.register(new AgentDefinition({
    id: 'MEMORY_AGENT',
    capabilities: ['memory.read', 'memory.write', 'memory.delete'],
    allowedMemoryScopes: ['personal', 'shared.memory']
  }));

  agentRegistry.register(new AgentDefinition({
    id: 'RESEARCH_AGENT',
    capabilities: ['memory.read', 'memory.write'],
    allowedMemoryScopes: ['personal', 'shared.research']
  }));

  return {
    service: new MemoryService(repository, {
      memoryAccessPolicy: new MemoryAccessPolicy({ agentRegistry })
    }),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('memory access requires canonical tenant identity', async () => {
  const fixture = createService();
  try {
    await assert.rejects(
      async () => fixture.service.list('', { agentId: 'MEMORY_AGENT' }),
      error => error.code === 'MEMORY_TENANT_REQUIRED'
    );
  } finally {
    fixture.cleanup();
  }
});

test('tenant identity cannot be overridden by memory tool input', async () => {
  const fixture = createService();
  try {
    const stored = await fixture.service.add(
      'Tenant A secret',
      { type: 'note', tenantId: 'tenant-b' },
      { agentId: 'MEMORY_AGENT', tenantId: 'tenant-a' }
    );

    assert.equal(stored.tenantId, 'tenant-a');
    assert.equal((await fixture.service.list('', {
      agentId: 'MEMORY_AGENT', tenantId: 'tenant-a'
    })).length, 1);
    assert.equal((await fixture.service.list('', {
      agentId: 'MEMORY_AGENT', tenantId: 'tenant-b'
    })).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('cross-tenant reads and deletes are isolated', async () => {
  const fixture = createService();
  try {
    const stored = await fixture.service.add(
      'Tenant A memory',
      {},
      { agentId: 'MEMORY_AGENT', tenantId: 'tenant-a' }
    );

    await assert.rejects(
      async () => fixture.service.get(stored.id, {
        agentId: 'MEMORY_AGENT', tenantId: 'tenant-b'
      }),
      error => error.code === 'MEMORY_NOT_FOUND'
    );

    await assert.rejects(
      async () => fixture.service.delete(stored.id, {
        agentId: 'MEMORY_AGENT', tenantId: 'tenant-b'
      }),
      error => error.code === 'MEMORY_NOT_FOUND'
    );

    assert.equal((await fixture.service.get(stored.id, {
      agentId: 'MEMORY_AGENT', tenantId: 'tenant-a'
    })).text, 'Tenant A memory');
  } finally {
    fixture.cleanup();
  }
});

test('agent scope boundary is enforced before repository access', async () => {
  const fixture = createService();
  try {
    await assert.rejects(
      async () => fixture.service.list('', {
        agentId: 'RESEARCH_AGENT',
        tenantId: 'tenant-a',
        memoryScope: 'shared.memory'
      }),
      error => error.code === 'MEMORY_SCOPE_FORBIDDEN'
    );
  } finally {
    fixture.cleanup();
  }
});

test('allowed shared scopes are isolated from other scopes', async () => {
  const fixture = createService();
  try {
    const stored = await fixture.service.add(
      'Research-only memory',
      { scope: 'shared.research' },
      { agentId: 'RESEARCH_AGENT', tenantId: 'tenant-a' }
    );

    assert.equal(stored.scope, 'shared.research');
    assert.equal(await fixture.service.list('', {
      agentId: 'RESEARCH_AGENT',
      tenantId: 'tenant-a',
      memoryScope: 'personal'
    })).length, 0);
    assert.equal(await fixture.service.list('', {
      agentId: 'RESEARCH_AGENT',
      tenantId: 'tenant-a',
      memoryScope: 'shared.research'
    })).length, 1);
  } finally {
    fixture.cleanup();
  }
});
