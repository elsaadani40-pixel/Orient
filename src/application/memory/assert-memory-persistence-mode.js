'use strict';

function assertMemoryPersistenceMode(mode) {
  if (mode === 'json' || mode === 'sqlite') return;

  if (mode === 'postgres') {
    const error = new Error(
      'PostgreSQL persistence is not yet safe for the synchronous MemoryService. ' +
      'The application must not fall back to JSON or start with a partially wired memory backend.'
    );
    error.code = 'MEMORY_PERSISTENCE_ASYNC_ADAPTER_REQUIRED';
    throw error;
  }

  const error = new Error(`Unsupported memory persistence mode "${mode}". Supported modes: json, sqlite`);
  error.code = 'MEMORY_PERSISTENCE_MODE_UNSUPPORTED';
  throw error;
}

module.exports = assertMemoryPersistenceMode;
