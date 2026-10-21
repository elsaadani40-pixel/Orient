'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OwnerChatConversationStore, MAX_MESSAGE_CHARS } = require('../../src/infrastructure/persistence/owner-chat-conversation-store');

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-chat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: new OwnerChatConversationStore({ filePath: path.join(dir, 'conversation.json'), ...options }) };
}

test('conversation store starts empty without creating a file', async t => {
  const { dir, store } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.access(path.join(dir, 'conversation.json')), { code: 'ENOENT' });
});

test('messages survive store recreation and preserve order', async t => {
  const { dir, store } = await fixture(t);
  await store.append({ id: 'u1', role: 'user', content: 'Hello' });
  await store.append({ id: 'a1', role: 'assistant', content: 'Hi there' });
  const reopened = new OwnerChatConversationStore({ filePath: path.join(dir, 'conversation.json') });
  const messages = await reopened.list();
  assert.deepEqual(messages.map(message => [message.id, message.role, message.content]), [
    ['u1', 'user', 'Hello'], ['a1', 'assistant', 'Hi there']
  ]);
});

test('repeated message ids are idempotent and conflicting replays fail closed', async t => {
  const { store } = await fixture(t);
  const first = await store.append({ id: 'same', role: 'user', content: 'Hello' });
  const replay = await store.append({ id: 'same', role: 'user', content: 'Hello' });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  await assert.rejects(store.append({ id: 'same', role: 'user', content: 'Different' }), {
    code: 'OWNER_CHAT_IDEMPOTENCY_CONFLICT'
  });
  assert.equal((await store.list()).length, 1);
});

test('task links are durable, idempotent, and reject conflicting or missing links', async t => {
  const { dir, store } = await fixture(t);
  await store.append({ id: 'user-message-1', role: 'user', content: 'Run a task' });

  const linked = await store.attachTaskId('user-message-1', 'exec-42');
  assert.equal(linked.replayed, false);
  assert.equal(linked.message.taskId, 'exec-42');

  const replay = await store.attachTaskId('user-message-1', 'exec-42');
  assert.equal(replay.replayed, true);
  await assert.rejects(store.attachTaskId('user-message-1', 'exec-43'), {
    code: 'OWNER_CHAT_TASK_LINK_CONFLICT'
  });
  await assert.rejects(store.attachTaskId('missing-message', 'exec-42'), {
    code: 'OWNER_CHAT_MESSAGE_NOT_FOUND'
  });

  const reopened = new OwnerChatConversationStore({ filePath: path.join(dir, 'conversation.json') });
  assert.equal((await reopened.list())[0].taskId, 'exec-42');
});

test('validates roles, ids, control characters, and message size', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.append({ id: 'bad role', role: 'system', content: 'secret' }), {
    code: 'OWNER_CHAT_MESSAGE_INVALID'
  });
  await assert.rejects(store.append({ id: 'ok', role: 'user', content: 'bad\u0000text' }), {
    code: 'OWNER_CHAT_MESSAGE_INVALID'
  });
  await assert.rejects(store.append({ id: 'big', role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }), {
    code: 'OWNER_CHAT_MESSAGE_INVALID'
  });
  assert.deepEqual(await store.list(), []);
});

test('bounds history and serializes concurrent writes', async t => {
  const { store } = await fixture(t, { maxMessages: 3 });
  await Promise.all([
    store.append({ id: '1', role: 'user', content: 'one' }),
    store.append({ id: '2', role: 'assistant', content: 'two' }),
    store.append({ id: '3', role: 'user', content: 'three' }),
    store.append({ id: '4', role: 'assistant', content: 'four' })
  ]);
  assert.deepEqual((await store.list()).map(message => message.id), ['2', '3', '4']);
});

test('clear removes conversation history durably', async t => {
  const { dir, store } = await fixture(t);
  await store.append({ id: 'u1', role: 'user', content: 'erase me' });
  assert.deepEqual(await store.clear(), { cleared: true });
  const reopened = new OwnerChatConversationStore({ filePath: path.join(dir, 'conversation.json') });
  assert.deepEqual(await reopened.list(), []);
});
