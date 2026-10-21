'use strict';

const {
  normalizeProfile,
  DEFAULT_PROFILE,
  MAX_PREFERENCES_CHARS
} = require('../owner-work-profile-store');

class PostgresOwnerWorkProfileRepository {
  constructor(db, { ownerId = 'owner' } = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.transaction !== 'function') {
      throw new TypeError('PostgreSQL owner profile repository requires a database adapter');
    }
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(ownerId)) {
      throw new TypeError('ownerId is invalid');
    }
    this.db = db;
    this.ownerId = ownerId;
  }

  mapRow(row) {
    return {
      version: 1,
      mode: row.mode,
      workingPreferences: row.working_preferences,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  async get() {
    const result = await this.db.query(
      'SELECT mode, working_preferences, updated_at FROM owner_work_profiles WHERE owner_id=$1',
      [this.ownerId]
    );
    if (!result.rows.length) return { ...DEFAULT_PROFILE };
    return this.mapRow(result.rows[0]);
  }

  async update(input) {
    return this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['owner-profile:' + this.ownerId]);
      const result = await client.query(
        'SELECT mode, working_preferences, updated_at FROM owner_work_profiles WHERE owner_id=$1 FOR UPDATE',
        [this.ownerId]
      );
      const current = result.rows.length ? this.mapRow(result.rows[0]) : { ...DEFAULT_PROFILE };
      const normalized = normalizeProfile(input, current);
      const updatedAt = new Date().toISOString();
      const saved = await client.query(
        `INSERT INTO owner_work_profiles(owner_id, mode, working_preferences, updated_at)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(owner_id) DO UPDATE SET
           mode=EXCLUDED.mode,
           working_preferences=EXCLUDED.working_preferences,
           updated_at=EXCLUDED.updated_at
         RETURNING mode, working_preferences, updated_at`,
        [this.ownerId, normalized.mode, normalized.workingPreferences, updatedAt]
      );
      return this.mapRow(saved.rows[0]);
    });
  }
}

module.exports = PostgresOwnerWorkProfileRepository;
