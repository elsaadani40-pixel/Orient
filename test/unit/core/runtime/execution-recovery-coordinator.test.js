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
    'persistExecution',
    'persistEvents',
    'checkpoint'
  ]);
  assert.equal(calls.at(-1)[1], 'update');
  assert.equal(calls.at(-1)[3], 'resume_failed');
});
