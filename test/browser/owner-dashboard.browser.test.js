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
  await ownerPage.locator('#runtime-status.error').waitFor({ timeout: 10000 });
  assert.match(await ownerPage.locator('#runtime-detail').innerText(), /فشل فحص واجهة المهام/);

  const ownerState = JSON.parse(fs.readFileSync(dataDir + '/owner.json', 'utf8'));
  assert.equal(ownerState.mustChangePassword, false);
  assert.notEqual(ownerState.password, 'orient-browser-owner-password-2026!');
  assert.equal(typeof ownerState.password?.salt, 'string');
  assert.equal(typeof ownerState.password?.hash, 'string');

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
