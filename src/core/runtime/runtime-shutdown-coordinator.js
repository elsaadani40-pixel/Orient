'use strict';

class RuntimeShutdownCoordinator {
  constructor({
    server = null,
    workerService = null,
    runtime,
    persistenceRuntime = null,
    eventStoreSubscriber = null,
    onError = () => {}
  } = {}) {
    if (!runtime || typeof runtime.shutdown !== 'function') {
      throw new TypeError('runtime.shutdown is required');
    }
    if (typeof onError !== 'function') throw new TypeError('onError must be a function');

    this.server = server;
    this.workerService = workerService;
    this.runtime = runtime;
    this.persistenceRuntime = persistenceRuntime;
    this.eventStoreSubscriber = eventStoreSubscriber;
    this.onError = onError;
    this.shutdownPromise = null;
  }

  shutdown({ runtimeOptions = { cancelQueued: false } } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(runtimeOptions);
    return this.shutdownPromise;
  }

  async performShutdown(runtimeOptions) {
    const errors = [];
    const runStage = async (stage, operation) => {
      if (typeof operation !== 'function') return;
      try {
        await operation();
      } catch (error) {
        errors.push({ stage, error });
        try { this.onError(error, stage); } catch {}
      }
    };

    await runStage('event-subscriber', () => this.eventStoreSubscriber?.stop?.());

    // Stop accepting requests before draining workers, so no new task can race
    // with shutdown. Existing requests finish before workers are stopped.
    await runStage('http-server', () => this.closeServer());

    // A worker may still be committing an external result. Drain it before
    // shutting down the runtime and closing durable persistence.
    await runStage('async-worker', async () => {
      if (typeof this.workerService?.stopAndDrain === 'function') {
        await this.workerService.stopAndDrain();
      }
    });

    await runStage('runtime', () => this.runtime.shutdown(runtimeOptions));

    await runStage('persistence', async () => {
      if (typeof this.persistenceRuntime?.close === 'function') {
        await this.persistenceRuntime.close();
      }
    });

    return { completed: errors.length === 0, errors };
  }

  closeServer() {
    if (!this.server || typeof this.server.close !== 'function') return Promise.resolve();
    if (this.server.listening === false) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
  }
}

module.exports = RuntimeShutdownCoordinator;
