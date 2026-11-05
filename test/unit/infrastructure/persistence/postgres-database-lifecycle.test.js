const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresDatabase, MIGRATIONS } = require('../../../../src/infrastructure/persistence/postgres/postgres-database');

test('PostgreSQL runtime initialization is read-only and refuses an absent schema', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rows: [{ ready: false }] };
    },
    async connect() {
      throw new Error('runtime initialization must not acquire a migration client');
    }
  };
  const database = new PostgresDatabase({ pool });

  await assert.rejects(
    () => database.initialize(),
    error => error.code === 'PERSISTENCE_SCHEMA_NOT_READY'
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /to_regclass/);
  assert.equal(calls.some(sql => /CREATE TABLE|ALTER TABLE|INSERT INTO/i.test(sql)), false);
});

test('PostgreSQL runtime initialization only verifies the installed schema version', async () => {
  const calls = [];
  const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (/to_regclass/.test(sql)) return { rows: [{ ready: true }] };
      return { rows: [{ version: latest }] };
    },
    async connect() {
      throw new Error('runtime initialization must not acquire a migration client');
    }
  };
  const database = new PostgresDatabase({ pool });

  assert.deepEqual(await database.initialize(), { schemaVersion: latest });
  assert.equal(calls.length, 2);
  assert.equal(calls.some(sql => /CREATE TABLE|ALTER TABLE|INSERT INTO/i.test(sql)), false);
});

test('PostgreSQL runtime initialization rejects an outdated schema', async () => {
  const pool = {
    async query(sql) {
      if (/to_regclass/.test(sql)) return { rows: [{ ready: true }] };
      return { rows: [{ version: 1 }] };
    },
    async connect() {
      throw new Error('runtime initialization must not acquire a migration client');
    }
  };
  const database = new PostgresDatabase({ pool });

  await assert.rejects(
    () => database.initialize(),
    error => error.code === 'PERSISTENCE_SCHEMA_OUTDATED'
      && error.currentVersion === 1
      && error.expectedVersion === Math.max(...MIGRATIONS.map(migration => migration.version))
  );
});

test('PostgreSQL migration role is transaction-local and cannot leak through a pooled connection', async () => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT COALESCE(MAX(version),0)::int AS version')) {
        return { rows: [{ version: Math.max(...MIGRATIONS.map(migration => migration.version)) }] };
      }
      return { rows: [] };
    },
    release() { releases += 1; }
  };
  const database = new PostgresDatabase({
    pool: {
      async query() { throw new Error('migration must use its checked-out client'); },
      async connect() { return client; }
    }
  });

  const result = await database.migrate({ role: 'orient_owner' });

  assert.equal(result.schemaVersion, Math.max(...MIGRATIONS.map(migration => migration.version)));
  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls[1], 'SET LOCAL ROLE orient_owner');
  assert.ok(calls.indexOf('SET LOCAL ROLE orient_owner') < calls.indexOf('COMMIT'));
  assert.equal(calls.some(sql => /^SET ROLE /i.test(sql)), false);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(releases, 1);
});

const validPrincipal = (overrides = {}) => ({
  principalId: '11111111-1111-4111-8111-111111111111',
  ownerId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-alpha',
  workspaceId: 'workspace-main',
  sessionId: '22222222-2222-4222-8222-222222222222',
  authSource: 'orient-owner-session',
  ...overrides
});

test('principal-scoped unit of work pins all repository queries to one transaction client', async () => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release() { releases += 1; }
  };
  const pool = {
    async query() { throw new Error('scoped work must not use pool.query'); },
    async connect() { return client; }
  };
  const database = new PostgresDatabase({ pool });

  const result = await database.withPrincipal(validPrincipal(), async () => {
    await database.query('SELECT scoped_repository_call');
    await database.transaction(async tx => {
      await database.query('SELECT nested_repository_call');
      await tx.query('SELECT explicit_transaction_call');
    });
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.deepEqual(calls.map(call => call.sql), [
    'BEGIN',
    "SELECT set_config('app.orient_principal_id', $1, true), set_config('app.orient_owner_id', $2, true), set_config('app.orient_tenant_id', $3, true), set_config('app.orient_workspace_id', $4, true), set_config('app.orient_session_id', $5, true)",
    'SELECT scoped_repository_call',
    'SAVEPOINT orient_nested_1',
    'SELECT nested_repository_call',
    'SELECT explicit_transaction_call',
    'RELEASE SAVEPOINT orient_nested_1',
    'COMMIT'
  ]);
  assert.deepEqual(calls[1].values, [
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'tenant-alpha',
    'workspace-main',
    '22222222-2222-4222-8222-222222222222'
  ]);
  assert.equal(releases, 1);
});

test('principal context cannot be switched inside a transaction and rolls back', async () => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(sql); return { rows: [] }; },
    release() {}
  };
  const database = new PostgresDatabase({ pool: { query() {}, async connect() { return client; } } });
  const other = validPrincipal({
    principalId: '33333333-3333-4333-8333-333333333333',
    ownerId: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant-beta',
    sessionId: '44444444-4444-4444-8444-444444444444'
  });

  await assert.rejects(
    () => database.withPrincipal(validPrincipal(), () =>
      database.withPrincipal(other, async () => database.query('SHOULD_NOT_RUN'))
    ),
    error => error.code === 'PERSISTENCE_PRINCIPAL_SWITCH_REJECTED'
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.includes('SHOULD_NOT_RUN'), false);
});

test('principal context is transaction-local and re-established for each pooled connection lease', async () => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql, values = []) { calls.push({ sql, values }); return { rows: [] }; },
    release() { releases += 1; }
  };
  const database = new PostgresDatabase({ pool: { query() {}, async connect() { return client; } } });
  const alpha = validPrincipal();
  const beta = validPrincipal({
    principalId: '33333333-3333-4333-8333-333333333333',
    ownerId: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant-beta',
    sessionId: '44444444-4444-4444-8444-444444444444'
  });

  await database.withPrincipal(alpha, async () => database.query('SELECT alpha'));
  await database.withPrincipal(beta, async () => database.query('SELECT beta'));

  const contextCalls = calls.filter(call => /set_config/.test(call.sql));
  assert.equal(contextCalls.length, 2);
  assert.equal(contextCalls[0].values[2], 'tenant-alpha');
  assert.equal(contextCalls[1].values[2], 'tenant-beta');
  assert.deepEqual(calls.filter(call => ['BEGIN', 'COMMIT'].includes(call.sql)).map(call => call.sql),
    ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  assert.equal(releases, 2);
});

test('principal-scoped unit of work rejects unverified or malformed principals before connecting', async () => {
  let connects = 0;
  const database = new PostgresDatabase({ pool: { query() {}, async connect() { connects += 1; return { query() {}, release() {} }; } } });
  await assert.rejects(
    () => database.withPrincipal({ tenantId: 'tenant-alpha' }, async () => {}),
    error => error.code === 'PERSISTENCE_PRINCIPAL_INVALID'
  );
  await assert.rejects(
    () => database.withPrincipal(validPrincipal({ authSource: 'supabase-user-metadata' }), async () => {}),
    error => error.code === 'PERSISTENCE_PRINCIPAL_INVALID'
  );
  assert.equal(connects, 0);
});


test('principal transaction discards its pooled client when rollback fails', async () => {
  const operationError = new Error('operation failed');
  const rollbackError = new Error('connection lost during rollback');
  const calls = [];
  let releasedWith;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    },
    release(error) { releasedWith = error; }
  };
  const database = new PostgresDatabase({
    pool: { query() {}, async connect() { return client; } }
  });

  await assert.rejects(
    () => database.withPrincipal(validPrincipal(), async () => { throw operationError; }),
    error => error === operationError
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(releasedWith, rollbackError);
});

test('standalone transaction discards its pooled client when rollback fails', async () => {
  const operationError = new Error('transaction work failed');
  const rollbackError = new Error('rollback connection failure');
  let releasedWith;
  const client = {
    async query(sql) {
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    },
    release(error) { releasedWith = error; }
  };
  const database = new PostgresDatabase({
    pool: { query() {}, async connect() { return client; } }
  });

  await assert.rejects(
    () => database.transaction(async () => { throw operationError; }),
    error => error === operationError
  );
  assert.equal(releasedWith, rollbackError);
});

test('migration discards its pooled client when rollback after commit failure fails', async () => {
  const commitError = new Error('commit transport failure');
  const rollbackError = new Error('rollback transport failure');
  const latest = Math.max(...MIGRATIONS.map(migration => migration.version));
  let releasedWith;
  const client = {
    async query(sql) {
      if (sql === 'SELECT COALESCE(MAX(version),0)::int AS version') {
        return { rows: [{ version: latest }] };
      }
      if (sql === 'COMMIT') throw commitError;
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    },
    release(error) { releasedWith = error; }
  };
  const database = new PostgresDatabase({
    pool: { query() {}, async connect() { return client; } }
  });

  await assert.rejects(
    () => database.migrate({ role: 'orient_owner' }),
    error => error === commitError
  );
  assert.equal(releasedWith, rollbackError);
});

test('failed nested savepoint rollback poisons the outer transaction and prevents commit', async () => {
  const nestedError = new Error('nested work failed');
  const rollbackError = new Error('savepoint rollback failed');
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'ROLLBACK TO SAVEPOINT orient_nested_1') throw rollbackError;
      return { rows: [] };
    },
    release() {}
  };
  const database = new PostgresDatabase({
    pool: { query() {}, async connect() { return client; } }
  });

  await assert.rejects(
    () => database.withPrincipal(validPrincipal(), async () => {
      await assert.rejects(
        () => database.transaction(async () => { throw nestedError; }),
        error => error === nestedError
      );
      return 'must-not-commit';
    }),
    error => error.code === 'PERSISTENCE_TRANSACTION_CLEANUP_FAILED' &&
      error.cause === rollbackError
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.includes('COMMIT'), false);
});
