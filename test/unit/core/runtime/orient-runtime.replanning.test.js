const test = require('node:test');
const assert = require('node:assert/strict');

const OrientRuntime =
  require('../../../../src/core/runtime/orient-runtime');

function createPlan(intent, tool, input) {
  return {
    intent,
    tool,
    input,
    confidence: 1,
    steps: [
      {
        step: 1,
        tool,
        input,
        dependsOn: null
      }
    ]
  };
}

test('runtime executes a validated replan instead of only recording the decision', async () => {
  const calls = [];
  let decisionCount = 0;

  const toolRegistry = {
    has(tool) {
      return tool === 'test.request-replan' ||
        tool === 'test.finalize';
    },

    get(tool) {
      return {
        name: tool
      };
    },

    async execute(tool) {
      calls.push(tool);

      if (tool === 'test.request-replan') {
        return {
          outcome: 'replan',
          nextAction: 'replan',
          nextInput: 'finalize the task'
        };
      }

      return {
        ok: true,
        value: 'completed'
      };
    }
  };

  const agentOrchestrator = {
    async plan(input) {
      assert.equal(input, 'start the task');

      return {
        plan: createPlan(
          'test.initial',
          'test.request-replan',
          'start'
        ),
        validation: {
          valid: true,
          steps: [
            {
              step: 1,
              tool: 'test.request-replan',
              input: 'start',
              dependsOn: null
            }
          ]
        }
      };
    },

    async replan({ evaluation, previousPlan }) {
      assert.equal(evaluation.outcome, 'replan');
      assert.equal(previousPlan.intent, 'test.initial');

      return {
        plan: createPlan(
          'test.final',
          'test.finalize',
          'finalize'
        ),
        validation: {
          valid: true,
          steps: [
            {
              step: 1,
              tool: 'test.finalize',
              input: 'finalize',
              dependsOn: null
            }
          ]
        }
      };
    },

    decideReplanning({ evaluation }) {
      decisionCount += 1;

      if (decisionCount === 1) {
        return {
          nextAction: 'replan',
          toJSON() {
            return {
              outcome: 'replan',
              nextAction: 'replan',
              reason: 'explicit replan requested'
            };
          }
        };
      }

      assert.equal(evaluation.outcome, 'done');

      return {
        nextAction: null,
        toJSON() {
          return {
            outcome: 'done',
            nextAction: null,
            reason: 'completed'
          };
        }
      };
    },

    async recover(error) {
      throw error;
    }
  };

  const runtime = new OrientRuntime({
    toolRegistry,
    agentOrchestrator
  });

  const result = await runtime.execute('start the task');

  assert.deepEqual(
    calls,
    [
      'test.request-replan',
      'test.finalize'
    ]
  );

  assert.equal(
    result.result.value,
    'completed'
  );

  assert.equal(
    result.replanning.outcome,
    'done'
  );

  assert.equal(
    result.execution.status,
    'completed'
  );

  assert.deepEqual(
    result.execution.steps.map(step => ({
      step: step.step,
      planRevision: step.planRevision,
      tool: step.tool,
      status: step.status
    })),
    [
      {
        step: 1,
        planRevision: 1,
        tool: 'test.request-replan',
        status: 'completed'
      },
      {
        step: 1,
        planRevision: 2,
        tool: 'test.finalize',
        status: 'completed'
      }
    ]
  );

  assert.equal(
    result.execution.events.some(
      event => event.type === 'replanning.executed'
    ),
    true
  );
});
