const test = require('node:test');
const assert = require('node:assert/strict');

const ExecutionRecoveryCoordinator = require('../../../../src/core/runtime/execution-recovery-coordinator');

test('classifies recovery, persists failure, and checkpoints resumed failures', async () => {
  const calls = [];
  const context = {
    isActive: () => true,
    canTransitionAgentTo: state => state === 'recovering',
    transitionAgentTo: state => calls.push(['transition', state]),
    record: (type, payload) => calls.push(['record', type, payload]),
    fail: error => calls.push(['fail', error.message])
  };

  const coordinator = new ExecutionRecoveryCoordinator({
    agentOrchestrator: {
      async recover(error) {
        return { action: 'retry', reason: error.message, target: 'step' };
      }
    },
    persistExecution: async (...args) => calls.push(['persistExecution', ...args]),
    persistEvents: async (...args) => calls.push(['persistEvents', ...args]),
    checkpoint: async (...args) => calls.push(['checkpoint', ...args])
  });

  const error = new Error('boom');
  const recovery = await coordinator.fail({
    context,
    error,
    checkpointReason: 'resume_failed'
  });

  assert.equal(recovery.action, 'retry');
  assert.deepEqual(calls.map(call => call[0]), [
    'transition',
    'record',
    'record',
    'fail',
    'checkpoint',
    'persistExecution',
    'persistEvents',
    'checkpoint'
  ]);
  assert.equal(calls.at(-1)[1], context);
  assert.equal(calls.at(-1)[2], 'update');
  assert.equal(calls.at(-1)[3], 'resume_failed');
  assert.equal(calls.find(call => call[0] === 'checkpoint')[3], 'resume_failed');
});


test('commits terminal failure checkpoint before a secondary persistence failure', async () => {
  const calls = [];
  const context = {
    isActive: () => true,
    canTransitionAgentTo: () => true,
    transitionAgentTo: state => calls.push(['transition', state]),
    record: (type, payload) => calls.push(['record', type, payload]),
    fail: error => calls.push(['fail', error.message])
  };

  const coordinator = new ExecutionRecoveryCoordinator({
    agentOrchestrator: {
      async recover() {
        return { action: 'abort', reason: 'fatal' };
      }
    },
    persistExecution: async () => {
      calls.push(['persistExecution']);
      throw Object.assign(new Error('event store unavailable'), {
        code: 'PERSISTENCE_FAILURE'
      });
    },
    persistEvents: async () => calls.push(['persistEvents']),
    checkpoint: async (...args) => calls.push(['checkpoint', ...args])
  });

  await assert.rejects(
    coordinator.fail({
      context,
      error: new Error('boom')
    }),
    error => error.code === 'PERSISTENCE_FAILURE'
  );

  assert.equal(calls.findIndex(call => call[0] === 'checkpoint') < calls.findIndex(call => call[0] === 'persistExecution'), true);
  assert.equal(calls.filter(call => call[0] === 'checkpoint').length, 1);
  assert.equal(calls.find(call => call[0] === 'checkpoint')[3], 'recovery_failure_committed');
});
