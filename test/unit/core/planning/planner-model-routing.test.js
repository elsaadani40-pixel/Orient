const test = require('node:test');
const assert = require('node:assert/strict');

const PlannerService = require('../../../../src/application/planner/planner.service');

test('PlannerService uses ModelRouter when a local provider is available', async () => {
  const planner = new PlannerService();

  const result = await planner.plan('find something', {
    modelRouter: {
      list: () => [{ id: 'ollama.local' }],
      complete: async () => ({
        text: JSON.stringify({
          intent: 'memory.search',
          confidence: 0.9,
          reason: 'local model',
          steps: [
            {
              tool: 'memory.search',
              input: 'something',
              dependsOn: null
            }
          ]
        }),
        routing: {
          providerId: 'ollama.local'
        }
      })
    }
  });

  assert.equal(result.intent, 'memory.search');
  assert.equal(result.routing.providerId, 'ollama.local');
  assert.equal(result.steps[0].tool, 'memory.search');
});

test('PlannerService safely falls back when local inference is unavailable', async () => {
  const planner = new PlannerService();

  const result = await planner.plan('ماذا تعرف عن القاهرة', {
    modelRouter: {
      list: () => [{ id: 'ollama.local' }],
      complete: async () => {
        throw Object.assign(
          new Error('offline'),
          { code: 'MODEL_PROVIDER_REQUEST_FAILED' }
        );
      }
    }
  });

  assert.equal(result.intent, 'memory.search');
  assert.equal(result.tool, 'memory.search');
});
