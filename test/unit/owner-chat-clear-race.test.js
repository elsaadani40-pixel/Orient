'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OwnerChatConversationStore } = require('../../src/infrastructure/persistence/owner-chat-conversation-store');
const PostgresOwnerChatConversationRepository = require('../../src/infrastructure/persistence/postgres/postgres-owner-chat-conversation-repository');
const { createPersistencePrincipal } = require('../../src/core/security/persistence-principal');

async function withJsonStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-owner-chat-'));
  const store = new OwnerChatConversationStore({ filePath: path.join(directory, 'chat.json') });
  try {
    await run(store);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('JSON store skips a late assistant answer after history is cleared', async () => {
  await withJsonStore(async store => {
    await store.append({ id: 'user-1', role: 'user', content: 'hello' });
    await store.attachTaskId('user-1', 'task-1');
    await store.clear();

    const result = await store.appendAssistantForTask({
      id: 'assistant-task-1', role: 'assistant', content: 'late answer', taskId: 'task-1'
    });

    assert.equal(result.skipped, true);
    assert.equal(result.message, null);
    assert.deepEqual(await store.list(), []);
  });
});

test('JSON store keeps the answer when it commits before clear, then clear wins', async () => {
  await withJsonStore(async store => {
    await store.append({ id: 'user-2', role: 'user', content: 'hello' });
    await store.attachTaskId('user-2', 'task-2');

    const answer = await store.appendAssistantForTask({
      id: 'assistant-task-2', role: 'assistant', content: 'answer', taskId: 'task-2'
    });
    assert.equal(answer.skipped, false);
    assert.equal((await store.list()).length, 2);

    await store.clear();
    assert.deepEqual(await store.list(), []);
  });
});

test('PostgreSQL repository skips a late assistant answer after history is cleared', async () => {
  const state = { messages: [] };
  const client = {
    async query(sql, values = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('DELETE FROM owner_chat_messages WHERE tenant_id=$1 AND owner_id=$2')) {
        state.messages = [];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("role='user' AND task_id=$3")) {
        return { rows: state.messages.filter(message =>
          message.tenant_id === values[0] && message.owner_id === values[1] &&
          message.role === 'user' && message.task_id === values[2]
        ).map(message => ({ message_id: message.message_id })), rowCount: 0 };
      }
      throw new Error('Unexpected SQL in test: ' + sql);
    }
  };
  const db = {
    transactionWithPrincipal: async (principal, callback) => callback(client, principal)
  };
  const repository = new PostgresOwnerChatConversationRepository(db);
  const principal = createPersistencePrincipal({
    tenantId: 'tenant-owner-chat-clear-race',
    ownerId: 'owner',
    sessionId: 'session-owner-chat-clear-race'
  });

  await repository.clear(principal);
  const result = await repository.appendAssistantForTask({
    id: 'assistant-task-3', role: 'assistant', content: 'late answer', taskId: 'task-3'
  }, principal);

  assert.equal(result.skipped, true);
  assert.equal(result.message, null);
  assert.deepEqual(state.messages, []);
});
