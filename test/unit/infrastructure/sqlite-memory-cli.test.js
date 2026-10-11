'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SqliteDatabase = require('../../../src/infrastructure/persistence/sqlite/sqlite-database');

test('CLI-backed :memory: database persists across calls without creating a repository file', () => {
  const database = new SqliteDatabase(':memory:');

  assert.notEqual(database.filePath, path.resolve(':memory:'));
  assert.ok(database.filePath.startsWith(os.tmpdir() + path.sep));
  assert.equal(fs.statSync(path.dirname(database.filePath)).mode & 0o777, 0o700);

  database.run('CREATE TABLE memory_probe (value TEXT NOT NULL);');
  database.run("INSERT INTO memory_probe(value) VALUES ('survives calls');");

  assert.deepEqual(database.query('SELECT value FROM memory_probe;'), [
    { value: 'survives calls' }
  ]);
});

test('each CLI-backed :memory: database has isolated state', () => {
  const first = new SqliteDatabase(':memory:');
  const second = new SqliteDatabase(':memory:');

  first.run('CREATE TABLE isolated_probe (value TEXT NOT NULL);');
  first.run("INSERT INTO isolated_probe(value) VALUES ('first');");

  assert.deepEqual(first.query('SELECT value FROM isolated_probe;'), [
    { value: 'first' }
  ]);
  assert.throws(
    () => second.query('SELECT value FROM isolated_probe;'),
    /no such table: isolated_probe/
  );
});
