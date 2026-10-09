const test = require('node:test');
const assert = require('node:assert/strict');

const createPersistence = require('../../../../src/infrastructure/persistence/persistence-factory');
const JsonPersistence = require('../../../../src/infrastructure/persistence/json-persistence');

const baseConfig = {
  persistenceMode: 'json',
  agentDataDirectory: '/tmp/orient-persistence-factory-test',
  databaseUrl: '',
  databasePoolMax: 2,
  databaseIdleTimeoutMs: 1000,
  databaseConnectionTimeoutMs: 1000
};

test('persistence factory selects JSON explicitly', () => {
  const result = createPersistence({ ...baseConfig, persistenceMode: 'json' });

  assert.ok(result.adapter instanceof JsonPersistence);
  assert.equal(typeof result.close, 'function');
});

test('persistence factory defaults to JSON when mode is omitted', () => {
  const { persistenceMode, ...config } = baseConfig;
  const result = createPersistence(config);

  assert.ok(result.adapter instanceof JsonPersistence);
});

test('persistence factory rejects unknown modes instead of silently falling back to JSON', () => {
  for (const persistenceMode of ['sqlite', 'postgress', 'unexpected', 'JSON', 'POSTGRES']) {
    assert.throws(
      () => createPersistence({ ...baseConfig, persistenceMode }),
      error => error.code === 'PERSISTENCE_MODE_UNSUPPORTED',
      persistenceMode
    );
  }
});

test('persistence factory requires a database URL for PostgreSQL mode', () => {
  assert.throws(
    () => createPersistence({ ...baseConfig, persistenceMode: 'postgres', databaseUrl: '' }),
    error => error.code === 'PERSISTENCE_DATABASE_URL_REQUIRED'
  );
});
