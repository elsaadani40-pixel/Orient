const { Pool } = require('pg');
const { PostgresPersistence } = require('./postgres-persistence');

function createPostgresPersistence({ connectionString = process.env.DATABASE_URL, ssl = undefined, poolOptions = {} } = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for PostgreSQL persistence');
  }

  const pool = new Pool({
    connectionString,
    ...(ssl === undefined ? {} : { ssl }),
    ...poolOptions
  });

  return {
    pool,
    persistence: new PostgresPersistence({ pool })
  };
}

module.exports = { createPostgresPersistence };
