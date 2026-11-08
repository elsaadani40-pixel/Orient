'use strict';

const {
  normalizeProfile,
  DEFAULT_PROFILE
} = require('../owner-work-profile-store');
const { assertPersistencePrincipal } = require('./persistence-principal');

class PostgresOwnerWorkProfileRepository {
  constructor(db) {
    if (!db || typeof db.transactionWithPrincipal !== 'function') {
      throw new TypeError('PostgreSQL owner profile repository requires principal-scoped transactions');
    }
    this.db = db;
  }

  mapRow(row) {
    return {
      version: 1,
      mode: row.mode,
      workingPreferences: row.working_preferences,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  async get(principal) {
    const identity = assertPersistencePrincipal(principal);
    return this.db.transactionWithPrincipal(principal, async client => {
      const result = await client.query(
        'SELECT mode, working_preferences, updated_at FROM owner_work_profiles WHERE tenant_id=$1 AND owner_id=$2',
        [identity.tenantId, identity.ownerId]
      );
      if (!result.rows.length) return { ...DEFAULT_PROFILE };
      return this.mapRow(result.rows[0]);
    });
  }

  async update(input, principal) {
    const identity = assertPersistencePrincipal(principal);
    return this.db.transactionWithPrincipal(principal, async client => {
      const scopeKey = 'owner-profile:' + identity.tenantId + ':' + identity.ownerId;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      const result = await client.query(
        'SELECT mode, working_preferences, updated_at FROM owner_work_profiles WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE',
        [identity.tenantId, identity.ownerId]
      );
      const current = result.rows.length ? this.mapRow(result.rows[0]) : { ...DEFAULT_PROFILE };
      const normalized = normalizeProfile(input, current);
      const updatedAt = new Date().toISOString();
      const saved = await client.query(
        `INSERT INTO owner_work_profiles(tenant_id, owner_id, mode, working_preferences, updated_at)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id, owner_id) DO UPDATE SET
           mode=EXCLUDED.mode,
           working_preferences=EXCLUDED.working_preferences,
           updated_at=EXCLUDED.updated_at
         RETURNING mode, working_preferences, updated_at`,
        [identity.tenantId, identity.ownerId, normalized.mode, normalized.workingPreferences, updatedAt]
      );
      return this.mapRow(saved.rows[0]);
    });
  }
}

module.exports = PostgresOwnerWorkProfileRepository;
