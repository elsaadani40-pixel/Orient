const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OrientRuntime =
  require('../../../../src/core/runtime/orient-runtime');

const ExecutionContext =
  require('../../../../src/core/execution/execution-context');

const CheckpointRepository =
  require('../../../../src/infrastructure/persistence/json/checkpoint.repository');

const IdempotencyRepository =
  require('../../../../src/infrastructure/persistence/json/idempotency.repository');

test('runtime resumes from the durable checkpoint without re-running completed steps', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orient-resume-')
  );

  const checkpoints =
    new CheckpointRepository(
      path.join(directory, 'checkpoints.json')
    );

  const idempotency =
    new IdempotencyRepository(
      path.join(directory, 'idempotency.json')
    );

  const context =
    new ExecutionContext({
      requestId: 'request-1',
      input: 'resume task',
      executionId: 'execution-1'
    });

  context.start();

  const plan = {
    intent: 'resume.test',
    confidence: 1,
    steps: [
      {
        step: 1,
        tool: 'test.first',
        input: 'first',
        dependsOn: null
      },
      {
        step: 2,
        tool: 'test.second',
        input: 'second',
        dependsOn: 1
      }
    ]
  };

  context.transitionAgentTo('planning');
  context.transitionAgentTo('validating');
  context.setPlan(plan);
  context.metadata.planRevision = 1;
  context.metadata.replans = 0;
  context.transitionAgentTo('executing');

  context.startStep({
    step: 1,
    tool: 'test.first',
    planRevision: 1
  });

  context.completeStep({
    step: 1,
    tool: 'test.first',
    result: { value: 'already done' },
    planRevision: 1
  });

  context.addObservation({
    step: 1,
    tool: 'test.first',
    success: true,
    result: { value: 'already done' }
  });

  checkpoints.save(
    context.snapshot(),
    { reason: 'step_completed' }
  );

  const calls = [];

  const toolRegistry = {
    has(tool) {
      return tool === 'test.first' ||
        tool === 'test.second';
    },

    get(tool) {
      return { name: tool };
    },

    async execute(tool) {
      calls.push(tool);

      return {
        value: 'resumed'
      };
    }
  };

  const agentOrchestrator = {
    decideReplanning({ evaluation }) {
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

  const runtime =
    new OrientRuntime({
      toolRegistry,
      agentOrchestrator,
      persistence: {
        checkpoints,
        idempotency
      }
    });

  const result =
    await runtime.resume(
      'execution-1'
    );

  assert.deepEqual(
    calls,
    ['test.second']
  );

  assert.equal(
    result.execution.status,
    'completed'
  );

  assert.equal(
    result.execution.steps.find(
      step =>
        step.step === 1 &&
        step.planRevision === 1
    ).result.value,
    'already done'
  );

  assert.equal(
    result.execution.steps.find(
      step =>
        step.step === 2 &&
        step.planRevision === 1
    ).result.value,
    'resumed'
  );

  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
});
