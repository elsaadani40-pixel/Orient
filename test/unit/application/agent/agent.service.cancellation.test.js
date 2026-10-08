'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentService = require('../../../../src/application/agent/agent.service');

test('AgentService exposes execution cancellation without transforming durable state', async () => {
  const expected = {
    executionId: 'exec-1',
    status: 'running',
    cancellationRequested: true
  };

  const service = new AgentService({
    cancelExecution: async (executionId, options) => {
      assert.equal(executionId, 'exec-1');
      assert.deepEqual(options, { reason: 'stop now' });
      return expected;
    }
  });

  assert.strictEqual(
    await service.cancelExecution('exec-1', { reason: 'stop now' }),
    expected
  );
});
