const test = require('node:test');
const assert = require('node:assert/strict');

const PlannerService = require('../../../../src/application/planner/planner.service');

test('PlannerService assigns memory intents to MEMORY_AGENT', async () => {
  const planner = new PlannerService();
  const plan = await planner.plan('ماذا تعرف عن القاهرة');

  assert.equal(plan.agentId, 'MEMORY_AGENT');
  assert.equal(plan.steps[0].agentId, 'MEMORY_AGENT');
});

test('PlannerService assigns non-memory intents to RESEARCH_AGENT', async () => {
  const planner = new PlannerService();
  const plan = await planner.plan('حلل هذا الطلب');

  assert.equal(plan.agentId, 'RESEARCH_AGENT');
  assert.equal(plan.steps.length, 0);
});
