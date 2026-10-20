'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 20000;
const ROLES = new Set(['user', 'assistant', 'system']);

function invalid(message, code = 'OWNER_CHAT_MESSAGE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Conversation message must be an object');
  }
  const role = input.role;
  const content = input.content;
  if (!ROLES.has(role) || role === 'system') {
    throw invalid('Conversation role is not allowed');
  }
  if (typeof content !== 'string' || !content.trim() ||
      content.length > MAX_MESSAGE_CHARS ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) {
    throw invalid('Conversation content must be plain text of at most 20000 characters');
  }
  const id = input.id === undefined ? randomUUID() : input.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw invalid('Conversation message id is invalid');
  }
  const createdAt = input.createdAt === undefined ? new Date().toISOString() : input.createdAt;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw invalid('Conversation message timestamp is invalid');
  }
  return { id, role, content: content.trim(), createdAt };
}

class OwnerChatConversationStore {
  constructor({ filePath, maxMessages = MAX_MESSAGES } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('OwnerChatConversationStore requires filePath');
    }
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_MESSAGES) {
      throw new TypeError('maxMessages must be between 1 and 500');
    }
    this.filePath = path.resolve(filePath);
    this.maxMessages = maxMessages;
    this.writeQueue = Promise.resolve();
  }

  async readRecord() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.messages)) {
        throw invalid('Conversation storage schema is invalid', 'OWNER_CHAT_STORAGE_INVALID');
      }
      const messages = parsed.messages.map(normalizeMessage);
      return { version: 1, messages: messages.slice(-this.maxMessages) };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, messages: [] };
      if (error instanceof SyntaxError) {
        throw invalid('Conversation storage is unreadable', 'OWNER_CHAT_STORAGE_INVALID');
      }
      throw error;
    }
  }

  async list() {
    const record = await this.readRecord();
    return record.messages.map(message => ({ ...message }));
  }

  async append(input) {
    const operation = this.writeQueue.then(async () => {
      const message = normalizeMessage(input);
      const record = await this.readRecord();
      const existing = record.messages.find(item => item.id === message.id);
      if (existing) {
        if (existing.role !== message.role || existing.content !== message.content) {
          throw invalid('Message id was already used for different content', 'OWNER_CHAT_IDEMPOTENCY_CONFLICT');
        }
        return { message: { ...existing }, replayed: true };
      }
      const next = {
        version: 1,
        messages: [...record.messages, message].slice(-this.maxMessages)
      };
      await this.writeRecord(next);
      return { message: { ...message }, replayed: false };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async clear() {
    const operation = this.writeQueue.then(async () => {
      await this.writeRecord({ version: 1, messages: [] });
      return { cleared: true };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async writeRecord(record) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = this.filePath + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(record) + '\n', {
        encoding: 'utf8', mode: 0o600, flag: 'wx'
      });
      await fs.rename(temporaryPath, this.filePath);
      try { await fs.chmod(this.filePath, 0o600); } catch (_) { /* POSIX modes may be unavailable */ }
    } catch (error) {
      try { await fs.unlink(temporaryPath); } catch (_) { /* no temporary file to clean */ }
      throw error;
    }
  }
}

module.exports = { OwnerChatConversationStore, MAX_MESSAGES, MAX_MESSAGE_CHARS, normalizeMessage };
