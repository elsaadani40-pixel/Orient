'use strict';

const RuntimeShutdownCoordinator = require('./runtime-shutdown-coordinator');

// This factory is the single composition seam used by app.js and by lifecycle
// integration tests. A worker is deliberately optional: production must not
// enable async execution until the adapter safety gate has been cleared.
function createProductionShutdownCoordinator({
  server,
  runtime,
  persistenceRuntime,
  eventStoreSubscriber,
  workerService = null,
  onError = () => {}
} = {}) {
  return new RuntimeShutdownCoordinator({
    server,
    runtime,
    persistenceRuntime,
    eventStoreSubscriber,
    workerService,
    onError
  });
}

module.exports = createProductionShutdownCoordinator;
