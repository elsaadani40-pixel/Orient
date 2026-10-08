'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentService = require('../../../../src/application/agent/agent.service');

test('AgentService exposes execution status without transforming durable state', () => {
  const expected = {
    executionId: 'exec-1',
    status: 'running',
    currentStep: 2
  };

  const service = new AgentService({
    getExecutionStatus: executionId => {
      assert.equal(executionId, 'exec-1');
      return expected;
    }
  });

  assert.strictEqual(service.getExecutionStatus('exec-1'), expected);
});
