const test = require('node:test');
const assert = require('node:assert/strict');

const createPersistence = require('../../../src/infrastructure/persistence/persistence-factory');

test('persistence factory defaults to local JSON without database configuration', async () => {
  const runtime = createPersistence({
    persistenceMode: 'json',
    agentDataDirectory: '/tmp/orient-test-data'
  });

  assert.equal(runtime.adapter.health().adapter, 'json');
  await runtime.close();
});

test('persistence factory fails closed when PostgreSQL mode has no URL', () => {
  assert.throws(
    () => createPersistence({
      persistenceMode: 'postgres',
      databaseUrl: ''
    }),
    error => error.message.includes('ORIENT_PERSISTENCE=postgres requires ORIENT_DATABASE_URL')
  );
});

test('persistence factory does not silently downgrade PostgreSQL mode', () => {
  assert.throws(
    () => createPersistence({
      persistenceMode: 'postgres',
      databaseUrl: ''
    }),
    error => !error.message.includes('json')
  );
});
