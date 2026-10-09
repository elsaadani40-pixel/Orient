const { Pool } = require('pg');
const { PostgresPersistence } = require('./postgres/postgres-persistence');
const JsonPersistence = require('./json-persistence');

function createPersistence(config) {
  const mode = config.persistenceMode || 'json';

  if (mode === 'json') {
    return {
      adapter: new JsonPersistence({
        dataDirectory: config.agentDataDirectory
      }),
      close: async () => {}
    };
  }

  if (mode !== 'postgres') {
    throw Object.assign(
      new Error(`Unsupported persistence mode "${mode}". Supported modes: json, postgres`),
      { code: 'PERSISTENCE_MODE_UNSUPPORTED' }
    );
  }

  if (!config.databaseUrl) {
    throw Object.assign(
      new Error(
        'ORIENT_PERSISTENCE=postgres requires ORIENT_DATABASE_URL'
      ),
      { code: 'PERSISTENCE_DATABASE_URL_REQUIRED' }
    );
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    application_name: 'orient-one'
  });

  const adapter = new PostgresPersistence({ pool });

  return {
    adapter,
    initialize: () => adapter.initialize(),
    close: () => pool.end()
  };
}

module.exports = createPersistence;
