'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const assertMemoryPersistenceMode = require('../../src/application/memory/assert-memory-persistence-mode');

test('JSON and SQLite memory modes remain supported', () => {
  assert.equal(assertMemoryPersistenceMode('json'), undefined);
  assert.equal(assertMemoryPersistenceMode('sqlite'), undefined);
});

test('PostgreSQL memory mode fails closed instead of silently falling back to JSON', () => {
  assert.throws(
    () => assertMemoryPersistenceMode('postgres'),
    error => error.code === 'MEMORY_PERSISTENCE_ASYNC_ADAPTER_REQUIRED' &&
      /must not fall back to JSON/.test(error.message)
  );
});

test('unknown memory persistence modes are rejected explicitly', () => {
  assert.throws(
    () => assertMemoryPersistenceMode('mysql'),
    error => error.code === 'MEMORY_PERSISTENCE_MODE_UNSUPPORTED'
  );
});
