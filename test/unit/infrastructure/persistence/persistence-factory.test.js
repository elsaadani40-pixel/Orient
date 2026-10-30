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
  for (const persistenceMode of ['postgress', 'unexpected', 'JSON', 'POSTGRES']) {
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


test('persistence factory selects SQLite and exposes memory repositories', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-factory-sqlite-'));
  const filePath = path.join(directory, 'memory.db');
  const result = createPersistence({
    ...baseConfig,
    persistenceMode: 'sqlite',
    databaseFile: filePath
  });
  try {
    assert.equal(result.adapter.health().adapter, 'sqlite');
    assert.equal(result.adapter.health().repositories.memory, true);
    assert.equal(typeof result.adapter.memory.findAll, 'function');
    assert.equal(typeof result.adapter.memoryAudit.append, 'function');
  } finally {
    await result.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
