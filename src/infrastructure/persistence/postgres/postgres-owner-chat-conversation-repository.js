'use strict';

const { normalizeMessage, MAX_MESSAGES } = require('../owner-chat-conversation-store');
const { assertPersistencePrincipal } = require('../../../core/security/persistence-principal');

function chatError(message, code = 'OWNER_CHAT_MESSAGE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

class PostgresOwnerChatConversationRepository {
  constructor(db, { maxMessages = MAX_MESSAGES } = {}) {
    if (!db || typeof db.transactionWithPrincipal !== 'function') {
      throw new TypeError('PostgreSQL owner chat repository requires principal-scoped transactions');
    }
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_MESSAGES) {
      throw new TypeError('maxMessages must be between 1 and 500');
    }
    this.db = db;
    this.maxMessages = maxMessages;
  }

  mapRow(row) {
    return {
      id: row.message_id,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString(),
      taskId: row.task_id || null
    };
  }

  async list(principal) {
    const identity = assertPersistencePrincipal(principal);
    return this.db.transactionWithPrincipal(principal, async client => {
      const result = await client.query(
        `SELECT message_id, role, content, created_at, task_id
         FROM (
           SELECT message_id, role, content, created_at, task_id
           FROM owner_chat_messages
           WHERE tenant_id=$1 AND owner_id=$2
           ORDER BY created_at DESC, message_id DESC
           LIMIT $3
         ) recent
         ORDER BY created_at ASC, message_id ASC`,
        [identity.tenantId, identity.ownerId, this.maxMessages]
      );
      return result.rows.map(row => this.mapRow(row));
    });
  }

  async append(input, principal) {
    const identity = assertPersistencePrincipal(principal);
    const message = normalizeMessage(input);
    return this.db.transactionWithPrincipal(principal, async client => {
      const scopeKey = 'owner-chat:' + identity.tenantId + ':' + identity.ownerId;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      const existingResult = await client.query(
        `SELECT message_id, role, content, created_at, task_id
         FROM owner_chat_messages
         WHERE tenant_id=$1 AND owner_id=$2 AND message_id=$3
         FOR UPDATE`,
        [identity.tenantId, identity.ownerId, message.id]
      );
      if (existingResult.rows.length) {
        const existing = this.mapRow(existingResult.rows[0]);
        if (existing.role !== message.role || existing.content !== message.content) {
          throw chatError('Message id was already used for different content', 'OWNER_CHAT_IDEMPOTENCY_CONFLICT');
        }
        return { message: existing, replayed: true };
      }
      const inserted = await client.query(
        `INSERT INTO owner_chat_messages(tenant_id,owner_id,message_id,role,content,created_at,task_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING message_id, role, content, created_at, task_id`,
        [identity.tenantId, identity.ownerId, message.id, message.role, message.content, message.createdAt, message.taskId]
      );
      await client.query(
        `DELETE FROM owner_chat_messages
         WHERE tenant_id=$1 AND owner_id=$2 AND message_id IN (
           SELECT message_id FROM owner_chat_messages
           WHERE tenant_id=$1 AND owner_id=$2
           ORDER BY created_at DESC, message_id DESC
           OFFSET $3
         )`,
        [identity.tenantId, identity.ownerId, this.maxMessages]
      );
      return { message: this.mapRow(inserted.rows[0]), replayed: false };
    });
  }

  async appendAssistantForTask(input, principal) {
    const identity = assertPersistencePrincipal(principal);
    if (!input || input.role !== 'assistant' ||
        typeof input.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.taskId)) {
      throw chatError('Assistant answer requires a valid task id');
    }
    const message = normalizeMessage(input);
    return this.db.transactionWithPrincipal(principal, async client => {
      const scopeKey = 'owner-chat:' + identity.tenantId + ':' + identity.ownerId;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      const source = await client.query(
        `SELECT message_id FROM owner_chat_messages
         WHERE tenant_id=$1 AND owner_id=$2 AND role='user' AND task_id=$3
         LIMIT 1 FOR UPDATE`,
        [identity.tenantId, identity.ownerId, message.taskId]
      );
      if (!source.rows.length) return { message: null, replayed: false, skipped: true };
      const existingResult = await client.query(
        `SELECT message_id, role, content, created_at, task_id
         FROM owner_chat_messages
         WHERE tenant_id=$1 AND owner_id=$2 AND message_id=$3
         FOR UPDATE`,
        [identity.tenantId, identity.ownerId, message.id]
      );
      if (existingResult.rows.length) {
        const existing = this.mapRow(existingResult.rows[0]);
        if (existing.role !== message.role || existing.content !== message.content ||
            existing.taskId !== message.taskId) {
          throw chatError('Message id was already used for different content', 'OWNER_CHAT_IDEMPOTENCY_CONFLICT');
        }
        return { message: existing, replayed: true, skipped: false };
      }
      const inserted = await client.query(
        `INSERT INTO owner_chat_messages(tenant_id,owner_id,message_id,role,content,created_at,task_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING message_id, role, content, created_at, task_id`,
        [identity.tenantId, identity.ownerId, message.id, message.role, message.content, message.createdAt, message.taskId]
      );
      await client.query(
        `DELETE FROM owner_chat_messages
         WHERE tenant_id=$1 AND owner_id=$2 AND message_id IN (
           SELECT message_id FROM owner_chat_messages
           WHERE tenant_id=$1 AND owner_id=$2
           ORDER BY created_at DESC, message_id DESC
           OFFSET $3
         )`,
        [identity.tenantId, identity.ownerId, this.maxMessages]
      );
      return { message: this.mapRow(inserted.rows[0]), replayed: false, skipped: false };
    });
  }

  async attachTaskId(messageId, taskId, principal) {
    const identity = assertPersistencePrincipal(principal);
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(messageId) ||
        typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) {
      throw chatError('Conversation message or task id is invalid');
    }
    return this.db.transactionWithPrincipal(principal, async client => {
      const scopeKey = 'owner-chat:' + identity.tenantId + ':' + identity.ownerId;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      const result = await client.query(
        `SELECT message_id, role, content, created_at, task_id
         FROM owner_chat_messages
         WHERE tenant_id=$1 AND owner_id=$2 AND message_id=$3
         FOR UPDATE`,
        [identity.tenantId, identity.ownerId, messageId]
      );
      if (!result.rows.length) {
        throw chatError('Conversation message was not found', 'OWNER_CHAT_MESSAGE_NOT_FOUND');
      }
      const existing = this.mapRow(result.rows[0]);
      if (existing.taskId && existing.taskId !== taskId) {
        throw chatError('Conversation message is already linked to another task', 'OWNER_CHAT_TASK_LINK_CONFLICT');
      }
      if (existing.taskId === taskId) return { message: existing, replayed: true };
      const updated = await client.query(
        `UPDATE owner_chat_messages SET task_id=$4
         WHERE tenant_id=$1 AND owner_id=$2 AND message_id=$3 AND task_id IS NULL
         RETURNING message_id, role, content, created_at, task_id`,
        [identity.tenantId, identity.ownerId, messageId, taskId]
      );
      if (!updated.rows.length) {
        throw chatError('Conversation task linkage lost a race', 'OWNER_CHAT_TASK_LINK_CONFLICT');
      }
      return { message: this.mapRow(updated.rows[0]), replayed: false };
    });
  }

  async clear(principal) {
    const identity = assertPersistencePrincipal(principal);
    return this.db.transactionWithPrincipal(principal, async client => {
      const scopeKey = 'owner-chat:' + identity.tenantId + ':' + identity.ownerId;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      await client.query(
        'DELETE FROM owner_chat_messages WHERE tenant_id=$1 AND owner_id=$2',
        [identity.tenantId, identity.ownerId]
      );
      return { cleared: true };
    });
  }
}

module.exports = PostgresOwnerChatConversationRepository;
