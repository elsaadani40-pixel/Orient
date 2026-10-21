'use strict';

const { normalizeMessage, MAX_MESSAGES } = require('../owner-chat-conversation-store');

function chatError(message, code = 'OWNER_CHAT_MESSAGE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

class PostgresOwnerChatConversationRepository {
  constructor(db, { ownerId = 'owner', maxMessages = MAX_MESSAGES } = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.transaction !== 'function') {
      throw new TypeError('Postgres owner chat repository requires a database adapter');
    }
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(ownerId)) {
      throw new TypeError('ownerId is invalid');
    }
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_MESSAGES) {
      throw new TypeError('maxMessages must be between 1 and 500');
    }
    this.db = db;
    this.ownerId = ownerId;
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

  async list() {
    const result = await this.db.query(
      `SELECT message_id, role, content, created_at, task_id
       FROM (
         SELECT message_id, role, content, created_at, task_id
         FROM owner_chat_messages
         WHERE owner_id=$1
         ORDER BY created_at DESC, message_id DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC, message_id ASC`,
      [this.ownerId, this.maxMessages]
    );
    return result.rows.map(row => this.mapRow(row));
  }

  async append(input) {
    const message = normalizeMessage(input);
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['owner-chat:' + this.ownerId]);
      const existingResult = await client.query(
        `SELECT message_id, role, content, created_at, task_id
         FROM owner_chat_messages WHERE owner_id=$1 AND message_id=$2 FOR UPDATE`,
        [this.ownerId, message.id]
      );
      if (existingResult.rows.length) {
        const existing = this.mapRow(existingResult.rows[0]);
        if (existing.role !== message.role || existing.content !== message.content) {
          throw chatError('Message id was already used for different content', 'OWNER_CHAT_IDEMPOTENCY_CONFLICT');
        }
        return { message: existing, replayed: true };
      }

      const inserted = await client.query(
        `INSERT INTO owner_chat_messages(owner_id,message_id,role,content,created_at,task_id)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING message_id, role, content, created_at, task_id`,
        [this.ownerId, message.id, message.role, message.content, message.createdAt, message.taskId]
      );
      await client.query(
        `DELETE FROM owner_chat_messages
         WHERE owner_id=$1 AND message_id IN (
           SELECT message_id FROM owner_chat_messages
           WHERE owner_id=$1
           ORDER BY created_at DESC, message_id DESC
           OFFSET $2
         )`,
        [this.ownerId, this.maxMessages]
      );
      return { message: this.mapRow(inserted.rows[0]), replayed: false };
    });
  }

  async attachTaskId(messageId, taskId) {
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(messageId) ||
        typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) {
      throw chatError('Conversation message or task id is invalid');
    }
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['owner-chat:' + this.ownerId]);
      const result = await client.query(
        `SELECT message_id, role, content, created_at, task_id
         FROM owner_chat_messages WHERE owner_id=$1 AND message_id=$2 FOR UPDATE`,
        [this.ownerId, messageId]
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
        `UPDATE owner_chat_messages SET task_id=$3
         WHERE owner_id=$1 AND message_id=$2 AND task_id IS NULL
         RETURNING message_id, role, content, created_at, task_id`,
        [this.ownerId, messageId, taskId]
      );
      if (!updated.rows.length) {
        throw chatError('Conversation task linkage lost a race', 'OWNER_CHAT_TASK_LINK_CONFLICT');
      }
      return { message: this.mapRow(updated.rows[0]), replayed: false };
    });
  }

  async clear() {
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['owner-chat:' + this.ownerId]);
      await client.query('DELETE FROM owner_chat_messages WHERE owner_id=$1', [this.ownerId]);
      return { cleared: true };
    });
  }
}

module.exports = PostgresOwnerChatConversationRepository;
