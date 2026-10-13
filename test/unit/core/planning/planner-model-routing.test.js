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

test('PlannerService sends schema-constrained submit-plan tool and accepts only registered tools', async () => {
  const planner = new PlannerService({
    toolRegistry: {
      list: () => [{ name: 'memory.search', description: 'Search approved memory' }],
      has: name => name === 'memory.search'
    }
  });
  let request;
  const result = await planner.plan('find something', {
    modelRouter: {
      list: () => [{ id: 'ollama.local' }],
      complete: async value => {
        request = value;
        return {
          text: '',
          toolCalls: [{
            name: 'submit_orient_plan',
            arguments: {
              intent: 'memory.search',
              confidence: 0.8,
              reason: 'Search memory',
              steps: [{ tool: 'memory.search', input: { query: 'something' }, dependsOn: null }]
            }
          }],
          routing: { providerId: 'ollama.local' }
        };
      }
    }
  });

  assert.equal(request.tools[0].function.name, 'submit_orient_plan');
  assert.deepEqual(request.format.properties.steps.items.properties.tool.enum, ['memory.search']);
  assert.equal(result.steps[0].tool, 'memory.search');
  assert.equal(result.routing.providerId, 'ollama.local');
});

test('PlannerService rejects unregistered model tools and falls back to deterministic planning', async () => {
  const planner = new PlannerService({
    toolRegistry: {
      list: () => [{ name: 'memory.search' }],
      has: name => name === 'memory.search'
    }
  });
  const result = await planner.plan('ماذا تعرف عن القاهرة', {
    modelRouter: {
      list: () => [{ id: 'ollama.local' }],
      complete: async () => ({
        text: '',
        toolCalls: [{
          name: 'submit_orient_plan',
          arguments: {
            intent: 'unsafe',
            confidence: 0.9,
            reason: 'unknown tool',
            steps: [{ tool: 'filesystem.shell', input: 'rm -rf /', dependsOn: null }]
          }
        }]
      })
    }
  });

  assert.equal(result.intent, 'memory.search');
  assert.equal(result.steps[0].tool, 'memory.search');
});

test('PlannerService replans from bounded observations through ModelRouter', async () => {
  const planner = new PlannerService();
  let userPayload;
  const modelRouter = {
    list: () => [{ id: 'ollama.local' }],
    complete: async request => {
      userPayload = JSON.parse(request.messages[1].content);
      return {
        text: JSON.stringify({
          intent: 'memory.search',
          confidence: 0.7,
          reason: 'Retry a narrower search',
          steps: [{ tool: 'memory.search', input: 'narrow query', dependsOn: null }]
        }),
        routing: { providerId: 'ollama.local' }
      };
    }
  };
  const result = await planner.replan({
    input: 'find something',
    evaluation: { outcome: 'replan', nextAction: 'replan', reason: 'search was too broad' },
    previousPlan: { intent: 'workspace.search', steps: [{ tool: 'workspace.search' }] },
    context: {
      requestId: 'req-1',
      observations: [{ step: 1, tool: 'workspace.search', success: false, result: { secret: 'must not be sent' } }]
    },
    modelRouter
  });

  assert.equal(result.replan, true);
  assert.equal(result.replanReason, 'search was too broad');
  assert.equal(userPayload.replan.observations[0].tool, 'workspace.search');
  assert.equal(JSON.stringify(userPayload).includes('must not be sent'), false);
});
