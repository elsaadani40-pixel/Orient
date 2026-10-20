'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OwnerWorkProfileStore, MAX_PREFERENCES_CHARS } = require('../../src/infrastructure/persistence/owner-work-profile-store');

test('owner work profile defaults without writing to browser storage', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new OwnerWorkProfileStore({ filePath: path.join(dir, 'owner-profile.json') });
  assert.deepEqual(await store.get(), {
    version: 1, mode: 'standard', workingPreferences: '', updatedAt: null
  });
  assert.equal(await fs.access(path.join(dir, 'owner-profile.json')).then(() => true, () => false), false);
});

test('owner work profile persists edits and preserves omitted fields', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'owner-profile.json');
  const store = new OwnerWorkProfileStore({ filePath });
  const first = await store.update({ mode: 'plan-only', workingPreferences: 'Inspect evidence before editing.' });
  assert.equal(first.mode, 'plan-only');
  assert.equal(first.workingPreferences, 'Inspect evidence before editing.');
  assert.ok(first.updatedAt);
  const second = await store.update({ mode: 'read-only-audit' });
  assert.equal(second.mode, 'read-only-audit');
  assert.equal(second.workingPreferences, first.workingPreferences);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), second);
  assert.equal((await store.get()).updatedAt, second.updatedAt);
});

test('owner work profile rejects invalid modes, control characters and oversized preferences', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new OwnerWorkProfileStore({ filePath: path.join(dir, 'owner-profile.json') });
  await assert.rejects(store.update({ mode: 'execute-everything' }), { code: 'OWNER_PROFILE_MODE_INVALID' });
  await assert.rejects(store.update({ workingPreferences: 'bad\u0000text' }), { code: 'OWNER_PROFILE_PREFERENCES_INVALID' });
  await assert.rejects(store.update({ workingPreferences: 'x'.repeat(MAX_PREFERENCES_CHARS + 1) }), { code: 'OWNER_PROFILE_PREFERENCES_INVALID' });
  assert.equal((await store.get()).workingPreferences, '');
});

test('concurrent profile writes serialize and leave a complete valid record', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new OwnerWorkProfileStore({ filePath: path.join(dir, 'owner-profile.json') });
  await Promise.all([
    store.update({ mode: 'plan-only', workingPreferences: 'first' }),
    store.update({ mode: 'read-only-audit', workingPreferences: 'second' }),
    store.update({ mode: 'standard', workingPreferences: 'third' })
  ]);
  const profile = await store.get();
  assert.equal(profile.version, 1);
  assert.equal(profile.mode, 'standard');
  assert.equal(profile.workingPreferences, 'third');
  assert.ok(profile.updatedAt);
});
