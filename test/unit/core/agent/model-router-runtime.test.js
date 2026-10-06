const test = require('node:test');
const assert = require('node:assert/strict');

const AgentOrchestrator = require('../../../../src/core/agent/orchestrator/agent-orchestrator');

test('AgentOrchestrator passes ModelRouter through the planning boundary', async () => {
  let received = null;

  const modelRouter = {
    complete: async () => ({
      text: 'ok',
      routing: {
        providerId: 'local-test'
      }
    })
  };

  const planner = {
    plan: async (input, options) => {
      received = options.modelRouter;
      return {
        intent: 'test',
        tool: null,
        steps: []
      };
    }
  };

  const orchestrator = new AgentOrchestrator({
    planner,
    planValidator: {
      validate: plan => ({
        valid: true,
        steps: plan.steps
      })
    },
    replanner: { decide: () => ({}) },
    decisionEngine: { decide: () => ({}) },
    recoveryEngine: { recover: () => ({}) },
    modelRouter
  });

  await orchestrator.plan('test', { executionId: 'e1' });

  assert.equal(received, modelRouter);
});

test('AgentOrchestrator records model routing metadata through the model boundary', async () => {
  const events = [];

  const orchestrator = new AgentOrchestrator({
    planner: { plan: async () => ({ intent: 'test', steps: [] }) },
    planValidator: {
      validate: plan => ({ valid: true, steps: plan.steps })
    },
    replanner: { decide: () => ({}) },
    decisionEngine: { decide: () => ({}) },
    recoveryEngine: { recover: () => ({}) },
    eventPublisher: {
      publish: async event => {
        events.push(event);
        return event;
      }
    },
    modelRouter: {
      complete: async () => ({
        text: 'ok',
        routing: { providerId: 'local-test' }
      })
    }
  });

  await orchestrator.completeModel(
    { requiredCapabilities: ['text-generation'] },
    { executionId: 'e1' }
  );

  assert.equal(events[0].type, 'model.routing.completed');
  assert.equal(events[0].data.routing.providerId, 'local-test');
});
