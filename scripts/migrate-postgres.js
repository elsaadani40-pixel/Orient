#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const { PostgresPersistence } = require('../src/infrastructure/persistence/postgres/postgres-persistence');

async function main() {
  const connectionString = process.env.ORIENT_DATABASE_URL;
  if (!connectionString) {
    throw Object.assign(
      new Error('ORIENT_DATABASE_URL is required to run database migrations.'),
      { code: 'PERSISTENCE_DATABASE_URL_REQUIRED' }
    );
  }

  const pool = new Pool({
    connectionString,
    application_name: 'orient-schema-migration'
  });

  try {
    const persistence = new PostgresPersistence({ pool });
    const result = await persistence.migrate();
    process.stdout.write(`ORIENT PostgreSQL schema is at version ${result.schemaVersion}.\\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`ORIENT database migration failed: ${error.message}\\n`);
  process.exitCode = 1;
});
