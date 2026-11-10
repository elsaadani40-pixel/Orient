'use strict';

const ERROR_LABELS = Object.freeze({
  'http-ingress': 'HTTP ingress shutdown failed',
  observations: 'Event subscriber shutdown failed',
  workers: 'Worker shutdown failed',
  runtime: 'Runtime shutdown failed',
  persistence: 'Persistence shutdown failed'
});

/**
 * Build the exact shutdown stages used by the production composition.
 * Worker shutdown is injected so production can remain disabled until the
 * provider-aware idempotency gate passes, while integration tests prove order.
 */
function createProductionShutdownStages({
  server,
  eventStoreSubscriber,
  stopWorkers = async () => {},
  runtime,
  persistenceRuntime = null,
  logger = null
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('server.close is required');
  }
  if (!eventStoreSubscriber || typeof eventStoreSubscriber.stop !== 'function') {
    throw new TypeError('eventStoreSubscriber.stop is required');
  }
  if (typeof stopWorkers !== 'function') {
    throw new TypeError('stopWorkers must be a function');
  }
  if (!runtime || typeof runtime.shutdown !== 'function') {
    throw new TypeError('runtime.shutdown is required');
  }
  if (persistenceRuntime !== null &&
      typeof persistenceRuntime.close !== 'undefined' &&
      typeof persistenceRuntime.close !== 'function') {
    throw new TypeError('persistenceRuntime.close must be a function when provided');
  }

  return {
    closeIngress: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    }),
    stopObservations: () => eventStoreSubscriber.stop(),
    stopWorkers,
    shutdownRuntime: () => runtime.shutdown({ cancelQueued: false }),
    closePersistence: () => (
      typeof persistenceRuntime?.close === 'function'
        ? persistenceRuntime.close()
        : Promise.resolve()
    ),
    onError(stage, error) {
      if (typeof logger?.error !== 'function') return;
      logger.error(ERROR_LABELS[stage] || 'Shutdown stage failed', {
        stage,
        code: error?.code || 'SHUTDOWN_STAGE_FAILED',
        message: error?.message || String(error)
      });
    }
  };
}

module.exports = createProductionShutdownStages;
