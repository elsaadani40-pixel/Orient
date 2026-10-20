'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_PROFILE = Object.freeze({
  version: 1,
  mode: 'standard',
  workingPreferences: '',
  updatedAt: null
});
const ALLOWED_MODES = new Set(['standard', 'read-only-audit', 'plan-only']);
const MAX_PREFERENCES_CHARS = 4000;

function normalizeProfile(input, previous = DEFAULT_PROFILE) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('Owner profile must be a JSON object');
    error.code = 'OWNER_PROFILE_INVALID';
    throw error;
  }
  const mode = input.mode === undefined ? previous.mode : input.mode;
  const workingPreferences = input.workingPreferences === undefined
    ? previous.workingPreferences
    : input.workingPreferences;
  if (!ALLOWED_MODES.has(mode)) {
    const error = new Error('Unsupported owner work mode');
    error.code = 'OWNER_PROFILE_MODE_INVALID';
    throw error;
  }
  if (typeof workingPreferences !== 'string' ||
      workingPreferences.length > MAX_PREFERENCES_CHARS ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(workingPreferences)) {
    const error = new Error('Owner work preferences must be plain text of at most 4000 characters');
    error.code = 'OWNER_PROFILE_PREFERENCES_INVALID';
    throw error;
  }
  return {
    version: 1,
    mode,
    workingPreferences: workingPreferences.trim(),
    updatedAt: previous.updatedAt || null
  };
}

class OwnerWorkProfileStore {
  constructor({ filePath }) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('OwnerWorkProfileStore requires filePath');
    }
    this.filePath = path.resolve(filePath);
    this.writeQueue = Promise.resolve();
  }

  async get() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const profile = normalizeProfile(parsed);
      return { ...profile, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null };
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_PROFILE };
      if (error instanceof SyntaxError) {
        const wrapped = new Error('Owner profile storage is unreadable');
        wrapped.code = 'OWNER_PROFILE_STORAGE_INVALID';
        throw wrapped;
      }
      throw error;
    }
  }

  async update(input) {
    const operation = this.writeQueue.then(async () => {
      const current = await this.get();
      const normalized = normalizeProfile(input, current);
      const next = { ...normalized, updatedAt: new Date().toISOString() };
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = this.filePath + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporaryPath, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporaryPath, this.filePath);
        try { await fs.chmod(this.filePath, 0o600); } catch (_) { /* best-effort on platforms without POSIX modes */ }
      } catch (error) {
        try { await fs.unlink(temporaryPath); } catch (_) { /* no temporary file to clean */ }
        throw error;
      }
      return next;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { OwnerWorkProfileStore, normalizeProfile, DEFAULT_PROFILE, MAX_PREFERENCES_CHARS };
