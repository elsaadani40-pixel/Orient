const test = require('node:test');
const assert = require('node:assert/strict');

const EvaluationEngine = require('../../../../src/core/agent/evaluation/evaluation-engine');
const AgentLoop = require('../../../../src/core/execution/agent-loop');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

function registry(counter) {
  const tool = { name: 'memory.save', retryable: false };
  return {
    has(name) { return name === tool.name; },
    get(name) { assert.equal(name, tool.name); return tool; },
    async execute(name, input) {
      assert.equal(name, tool.name);
      counter.count += 1;
      return { saved: true, input };
    }
  };
}

test('EvaluationEngine is the canonical evaluation decision point', () => {
  const engine = new EvaluationEngine();
  const plan = {
    steps: [
      { tool: 'memory.save' },
      { tool: 'memory.search' }
    ]
  };

  const first = engine.evaluate({
    plan,
    step: plan.steps[0],
    stepNumber: 1,
    result: { saved: true }
  });
  assert.equal(first.outcome, 'continue');
  assert.equal(first.nextAction, 'next_step');
  assert.equal(first.goalProgress, 0.5);

  const final = engine.evaluate({
    plan: { steps: [{ tool: 'memory.save' }] },
    step: { tool: 'memory.save' },
    stepNumber: 1,
    result: { saved: true }
  });
  assert.equal(final.outcome, 'done');

  const replan = engine.evaluate({
    plan,
    step: plan.steps[0],
    stepNumber: 1,
    result: { outcome: 'replan', reason: 'needs more context' }
  });
  assert.equal(replan.outcome, 'replan');

  const failed = engine.evaluate({
    plan,
    step: plan.steps[0],
    stepNumber: 1,
    result: undefined
  });
  assert.equal(failed.outcome, 'failed');

  const noAction = engine.evaluate({ plan: { steps: [] }, result: null, stepNumber: 0 });
  assert.equal(noAction.outcome, 'no_action');
});

test('AgentLoop delegates evaluation to the injected canonical engine', async () => {
  const counter = { count: 0 };
  const calls = [];
  const evaluationEngine = {
    evaluate(input) {
      calls.push(input);
      return {
        toJSON() {
          return {
            outcome: 'done',
            goalProgress: 1,
            confidence: 1,
            reason: 'canonical'
          };
        }
      };
    }
  };

  const loop = new AgentLoop({
    toolRegistry: registry(counter),
    evaluationEngine
  });

  const context = new ExecutionContext({
    requestId: 'evaluation-1',
    input: 'save',
    executionId: 'execution-evaluation-1'
  });
  context.start();
  context.setPlan({ steps: [{ tool: 'memory.save', input: { value: 'x' } }] });

  const result = await loop.run({
    plan: { steps: [{ tool: 'memory.save', input: { value: 'x' } }] },
    context
  });

  assert.equal(result.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stepNumber, 1);
  assert.equal(counter.count, 1);
});
