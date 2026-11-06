'use strict';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizeState(row) {
  if (!row) return null;
  const version = Number(row.version);
  const digest = String(row.digest || '').trim();
  if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{64}$/.test(digest)) {
    fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Persistent trust state is malformed');
  }
  return { version, digest };
}

/**
 * PostgreSQL CAS adapter for a separately administered trust-state database.
 *
 * The table must be provisioned by an administrator in a trust domain that is
 * not writable by the ORIENT runtime database identity. This adapter provides
 * atomic compare-and-set; it cannot create that administrative separation.
 */
class PostgresTrustManifestVersionStore {
  constructor({ pool, schema = 'public', table = 'orient_trust_manifest_state' } = {}) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('A PostgreSQL pool for the independent trust store is required');
    }
    if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(table)) {
      throw new TypeError('Trust store schema and table must be safe PostgreSQL identifiers');
    }
    this.pool = pool;
    this.qualifiedTable = '"'+schema+'"."'+table+'"';
  }

  async read() {
    const result = await this.pool.query(
      `SELECT version, digest FROM ${this.qualifiedTable} WHERE singleton_id='active'`
    );
    if (!result || !Array.isArray(result.rows) || result.rows.length > 1) {
      fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Trust store returned an invalid singleton state');
    }
    return normalizeState(result.rows[0] || null);
  }

  async compareAndSet(expectedState, nextState) {
    const next = normalizeState(nextState);
    if (!next) fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Next trust state is required');
    if (expectedState !== null) {
      const expected = normalizeState(expectedState);
      if (!expected || next.version <= expected.version) {
        fail('EVIDENCE_TRUST_MANIFEST_STORE_INVALID', 'Trust state versions must increase monotonically');
      }
      const result = await this.pool.query(
        `UPDATE ${this.qualifiedTable}
         SET version=$1, digest=$2, updated_at=clock_timestamp()
         WHERE singleton_id='active' AND version=$3 AND digest=$4
           AND $1::bigint > version
         RETURNING version`,
        [next.version, next.digest, expected.version, expected.digest]
      );
      return result?.rowCount === 1;
    }

    const result = await this.pool.query(
      `INSERT INTO ${this.qualifiedTable} (singleton_id, version, digest)
       VALUES ('active', $1, $2)
       ON CONFLICT (singleton_id) DO NOTHING
       RETURNING version`,
      [next.version, next.digest]
    );
    return result?.rowCount === 1;
  }
}

module.exports = { PostgresTrustManifestVersionStore };
