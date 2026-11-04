#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const { PostgresPersistence } = require('../src/infrastructure/persistence/postgres/postgres-persistence');

async function main() {
  const connectionString = process.env.ORIENT_MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw Object.assign(
      new Error('ORIENT_MIGRATION_DATABASE_URL is required for the dedicated migration-owner connection.'),
      { code: 'PERSISTENCE_DATABASE_URL_REQUIRED' }
    );
  }

  const migrationRole = process.env.ORIENT_MIGRATION_ROLE;
  if (migrationRole !== 'orient_owner') {
    throw new Error('ORIENT_MIGRATION_ROLE=orient_owner is required; provision roles before running migrations.');
  }

  const pool = new Pool({
    connectionString,
    application_name: 'orient-schema-migration'
  });

  try {
    const persistence = new PostgresPersistence({ pool });
    const result = await persistence.migrate({ role: migrationRole });
    process.stdout.write(`ORIENT PostgreSQL schema is at version ${result.schemaVersion}.\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`ORIENT database migration failed: ${error.message}\n`);
  process.exitCode = 1;
});
