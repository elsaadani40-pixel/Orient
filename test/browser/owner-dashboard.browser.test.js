'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const baseUrl = process.env.ORIENT_BASE_URL || 'http://127.0.0.1:8080';
const bootstrapPassword = process.env.ORIENT_OWNER_BOOTSTRAP_PASSWORD;
const dataDir = process.env.ORIENT_DATA_DIR;

test('real Chromium owner first-run flow, dashboard runtime failure state, and public-user isolation', async t => {
  assert.ok(bootstrapPassword, 'ORIENT_OWNER_BOOTSTRAP_PASSWORD must be supplied by the isolated CI job');
  assert.ok(dataDir, 'ORIENT_DATA_DIR must point to an isolated temporary directory');

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const ownerContext = await browser.newContext();
  t.after(() => ownerContext.close());
  const ownerPage = await ownerContext.newPage();

  await ownerPage.goto(baseUrl + '/auth?mode=owner');
  await ownerPage.getByLabel('اسم المستخدم').fill('Admin');
  await ownerPage.getByLabel('كلمة المرور', { exact: true }).fill(bootstrapPassword);
  await ownerPage.getByRole('button', { name: 'دخول لوحة المالك' }).click();
  await ownerPage.waitForURL('**/owner.html');

  await ownerPage.getByLabel('كلمة المرور الجديدة').fill('orient-browser-owner-password-2026!');
  await ownerPage.getByLabel('تأكيد كلمة المرور').fill('orient-browser-owner-password-2026!');
  await ownerPage.getByRole('button', { name: 'حفظ كلمة المرور والمتابعة' }).click();
  await ownerPage.waitForURL('**/dashboard.html');

  await ownerPage.getByRole('heading', { name: 'لوحة تحكم المالك' }).waitFor();
  await ownerPage.getByRole('heading', { name: 'اتصال محرك ORIENT' }).waitFor();
  await ownerPage.getByRole('button', { name: 'فحص الاتصال' }).waitFor();
  await ownerPage.locator('#runtime-status.status').waitFor({ timeout: 15000 });
  assert.match(await ownerPage.locator('#runtime-status').innerText(), /متصل/);
  assert.match(await ownerPage.locator('#runtime-detail').innerText(), /إجمالي المهام المسجل فعليًا: 0/);


  // Exercise the real owner chat UI with deterministic API fixtures. The
  // final answer contains HTML-looking text and must remain plain text in the DOM.
  await ownerPage.route('**/owner/chat**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/owner/chat') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ apiVersion: 'v1', task: { id: 'browser-final-answer', status: 'running' }, replayed: false })
      });
      return;
    }
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/owner/chat/browser-final-answer/response') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          apiVersion: 'v1',
          assistant: { text: 'نص آمن <img src=x data-test=literal>', status: 'available' },
          task: { id: 'browser-final-answer', status: 'completed' },
          evidenceReferences: [],
          approvalRequired: false
        })
      });
      return;
    }
    await route.continue();
  });
  await ownerPage.route('**/api/v1/tasks/browser-final-answer**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/events')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ apiVersion: 'v1', items: [], page: { limit: 50, nextCursor: null, hasMore: false, gapDetected: false } })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ apiVersion: 'v1', task: { id: 'browser-final-answer', status: 'completed' } })
    });
  });

  await ownerPage.goto(baseUrl + '/chat');
  await ownerPage.getByText('جلسة المالك مؤكدة', { exact: false }).waitFor({ timeout: 10000 });
  await ownerPage.getByLabel('رسالتك إلى ORIENT').fill('اختبار عرض الإجابة النهائية');
  await ownerPage.getByRole('button', { name: 'إرسال المهمة' }).click();
  const finalAnswer = ownerPage.locator('.final-answer .content');
  await finalAnswer.waitFor({ timeout: 10000 });
  assert.equal(await finalAnswer.textContent(), 'نص آمن <img src=x data-test=literal>');
  assert.equal(await ownerPage.locator('.final-answer img').count(), 0);
  assert.equal(await ownerPage.locator('.final-answer').getAttribute('aria-label'), 'إجابة ORIENT النهائية');

  const ownerState = JSON.parse(fs.readFileSync(dataDir + '/owner.json', 'utf8'));
  assert.equal(ownerState.mustChangePassword, false);
  assert.equal(typeof ownerState.passwordHash, 'string');
  assert.match(ownerState.passwordHash, /^[a-f0-9]{128}:[a-f0-9]{32}$/);
  assert.equal(Object.hasOwn(ownerState, 'password'), false);
  assert.ok(Array.isArray(ownerState.sessions));
  assert.equal(JSON.stringify(ownerState).includes('orient-browser-owner-password-2026!'), false);

  await ownerPage.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await ownerPage.waitForURL('**/auth?mode=owner');

  const publicContext = await browser.newContext();
  t.after(() => publicContext.close());
  const publicPage = await publicContext.newPage();
  await publicPage.goto(baseUrl + '/auth');
  await publicPage.getByRole('button', { name: 'إنشاء حساب' }).click();
  await publicPage.getByLabel('اسم المستخدم').fill('BrowserPublicUser');
  await publicPage.getByLabel('كلمة المرور', { exact: true }).fill('public-browser-password-2026!');
  await publicPage.getByLabel('تأكيد كلمة المرور').fill('public-browser-password-2026!');
  await publicPage.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await publicPage.waitForURL('**/account.html');

  await publicPage.goto(baseUrl + '/dashboard.html');
  await publicPage.waitForURL('**/auth?mode=owner');
  assert.equal(new URL(publicPage.url()).pathname, '/auth');
  assert.equal(new URL(publicPage.url()).searchParams.get('mode'), 'owner');
});
