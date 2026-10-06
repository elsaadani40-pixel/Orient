const test = require('node:test');
const assert = require('node:assert/strict');

const PlanValidator = require('../../../../src/core/planning/validation/plan-validator');

test('PlanValidator rejects unregistered tools when a registry is configured', () => {
  const validator = new PlanValidator({
    toolRegistry: {
      has: tool => tool === 'memory.search'
    }
  });

  assert.throws(
    () => validator.validate({
      intent: 'model.generated',
      steps: [
        {
          tool: 'unknown.tool',
          input: null
        }
      ]
    }),
    error => error.code === 'PLAN_TOOL_NOT_REGISTERED'
  );
});
