const test = require('node:test');
const assert = require('node:assert/strict');

const ModelRouter =
  require('../../../../src/core/model/model-router');

function provider(id, capabilities, locality, costClass) {
  return {
    id,
    capabilities,
    locality,
    costClass,
    async complete() {
      return { providerId: id, text: 'ok' };
    }
  };
}

test('model router selects the best policy-compatible provider', async () => {
  const router = new ModelRouter({
    providers: [
      provider('remote-expensive', ['reasoning'], 'remote', 'high'),
      provider('local-reasoning', ['reasoning'], 'local', 'free'),
      provider('local-basic', ['chat'], 'local', 'free')
    ]
  });

  const route = router.route({
    requiredCapabilities: ['reasoning'],
    preferredLocality: 'local',
    preferredCostClass: 'free'
  });

  assert.equal(route.providerId, 'local-reasoning');

  const result = await router.complete({
    requiredCapabilities: ['reasoning'],
    preferredLocality: 'local',
    preferredCostClass: 'free'
  });

  assert.equal(result.providerId, 'local-reasoning');
  assert.equal(result.routing.providerId, 'local-reasoning');
});

test('model router refuses unsupported capability', () => {
  const router = new ModelRouter({
    providers: [provider('basic', ['chat'], 'local', 'free')]
  });

  assert.throws(
    () => router.route({ requiredCapabilities: ['reasoning'] }),
    error => error.code === 'MODEL_CAPABILITY_UNAVAILABLE'
  );
});
