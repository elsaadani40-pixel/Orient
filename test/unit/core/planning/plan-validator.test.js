const test = require('node:test');
const assert = require('node:assert/strict');

const PlanValidator =
  require('../../../../src/core/planning/validation/plan-validator');

function createValidator(maxSteps = 5) {
  return new PlanValidator({ maxSteps });
}

test('valid plan is accepted and normalized', () => {
  const validator = createValidator();

  const result = validator.validate({
    intent: 'memory.search',
    confidence: 0.98,
    steps: [
      {
        tool: 'memory.search',
        input: { query: 'احمد' }
      }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'memory.search');
  assert.equal(result.steps[0].step, 1);
});

test('the same tool may appear in distinct plan steps', () => {
  const validator = createValidator();

  const result = validator.validate({
    intent: 'test',
    confidence: 0.9,
    steps: [
      { tool: 'memory.search', input: 'first' },
      { tool: 'memory.search', input: 'second' }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].tool, 'memory.search');
  assert.equal(result.steps[1].tool, 'memory.search');
});

test('maximum step limit is enforced', () => {
  const validator = createValidator(2);

  assert.throws(
    () => validator.validate({
      intent: 'test',
      confidence: 0.9,
      steps: [
        { tool: 'tool.a' },
        { tool: 'tool.b' },
        { tool: 'tool.c' }
      ]
    })
  );
});

test('invalid confidence is rejected', () => {
  const validator = createValidator();

  assert.throws(() => validator.validate({
    intent: 'test',
    confidence: 1.5,
    steps: []
  }));

  assert.throws(() => validator.validate({
    intent: 'test',
    confidence: -0.1,
    steps: []
  }));
});

test('missing intent is rejected', () => {
  const validator = createValidator();

  assert.throws(() => validator.validate({
    confidence: 0.9,
    steps: []
  }));
});

test('single-tool plans are normalized into execution steps', () => {
  const validator = createValidator();

  const result = validator.validate({
    intent: 'memory.search',
    confidence: 0.95,
    tool: 'memory.search'
  });

  assert.equal(result.valid, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'memory.search');
});
