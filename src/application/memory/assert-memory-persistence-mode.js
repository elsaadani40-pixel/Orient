'use strict';

function assertMemoryPersistenceMode(mode) {
  if (mode === 'json' || mode === 'sqlite' || mode === 'postgres') return;

  const error = new Error(`Unsupported memory persistence mode "${mode}". Supported modes: json, sqlite, postgres`);
  error.code = 'MEMORY_PERSISTENCE_MODE_UNSUPPORTED';
  throw error;
}

module.exports = assertMemoryPersistenceMode;
