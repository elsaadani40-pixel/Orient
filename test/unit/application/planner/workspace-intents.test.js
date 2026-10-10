'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PlannerService = require('../../../../src/application/planner/planner.service');

test('planner routes project file search to the scoped project builder agent', async () => {
  const planner = new PlannerService();
  const plan = await planner.plan('ابحث داخل ملفات المشروع عن NeedleValue');
  assert.equal(plan.tool, 'workspace.search');
  assert.equal(plan.input, 'NeedleValue');
  assert.equal(plan.agentId, 'PROJECT_BUILDER_AGENT');
  assert.equal(plan.steps[0].agentId, 'PROJECT_BUILDER_AGENT');
});

test('planner routes file reads and directory listings to workspace tools', async () => {
  const planner = new PlannerService();
  const read = await planner.plan('اقرأ الملف src/main.js');
  assert.equal(read.tool, 'workspace.read');
  assert.deepEqual(read.input, { path: 'src/main.js' });
  assert.equal(read.agentId, 'PROJECT_BUILDER_AGENT');

  const list = await planner.plan('اعرض الملفات في src');
  assert.equal(list.tool, 'workspace.list');
  assert.deepEqual(list.input, { path: 'src' });
  assert.equal(list.agentId, 'PROJECT_BUILDER_AGENT');
});

test('planner does not let a model-selected runtime identity broaden workspace access', () => {
  const planner = new PlannerService();
  const plan = planner.normalizePlan({
    intent: 'arbitrary',
    tool: 'workspace.read',
    agentId: 'ORIENT_RUNTIME',
    input: { path: 'src/main.js' },
    steps: []
  });
  assert.equal(plan.agentId, 'PROJECT_BUILDER_AGENT');
});
