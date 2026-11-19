'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExternalAgentProviderRegistry = require('../../../../src/application/agents/external-agent-provider-registry');

function provider(id = 'fixture') {
  return {
    id,
    health: async () => ({ ok: true }),
    listAgents: async () => [],
    listChannels: async () => [],
    listModels: async () => []
  };
}

test('external agent provider registry registers and resolves normalized providers', async () => {
  const registry = new ExternalAgentProviderRegistry();
  registry.register(provider());
  const registered = registry.get('fixture');

  assert.deepEqual(registry.list(), ['fixture']);
  assert.deepEqual(await registered.health(), { ok: true });
  assert.deepEqual(await registered.listAgents(), []);
});

test('external agent provider registry rejects incomplete and duplicate providers', () => {
  const registry = new ExternalAgentProviderRegistry();
  assert.throws(() => registry.register({ id: 'broken' }), /must implement health/);
  registry.register(provider());
  assert.throws(() => registry.register(provider()), { code: 'EXTERNAL_AGENT_PROVIDER_DUPLICATE' });
});

test('external agent provider registry rejects invalid identifiers and seals registration', () => {
  const registry = new ExternalAgentProviderRegistry();
  assert.throws(() => registry.register(provider('OpenMausBot')), /valid stable id/);
  registry.seal();
  assert.throws(() => registry.register(provider()), { code: 'EXTERNAL_AGENT_PROVIDER_REGISTRY_SEALED' });
});
