'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PlannerService = require('../../../src/application/planner/planner.service');

test('explicitly proposal-only project goal does not schedule execution', async () => {
  const planner = new PlannerService();
  const plan = await planner.plan(
    'حلل المشروع الحالي قراءة فقط، وحدد مشكلة فعلية مدعومة بالأدلة، واقترح تغييرًا محدودًا مع شروط التحقق والمخاطر. لا تنفذ التغيير في هذه المهمة.'
  );

  assert.equal(plan.intent, 'project.change.proposal');
  assert.deepEqual(plan.steps.map(step => step.tool), ['project.propose_changes']);
});

test('explicit owner-approved execution goal schedules proposal then gated execution', async () => {
  const planner = new PlannerService();
  const plan = await planner.plan(
    'حلل المشروع الحالي، وحدد تغييرًا آمنًا ومحددًا، ثم اطلب موافقة المالك قبل أي تعديل، ونفذ فقط التغيير المعتمد داخل مساحة العمل المقيدة، وشغّل التحقق المتاح، وارجع التغييرات إذا فشل التحقق.'
  );

  assert.equal(plan.intent, 'project.change');
  assert.deepEqual(plan.steps.map(step => step.tool), [
    'project.propose_changes',
    'project.execute_change'
  ]);
  assert.equal(plan.steps[1].dependsOn, 1);
  assert.equal(plan.steps[1].input, '$previousResult');
});
