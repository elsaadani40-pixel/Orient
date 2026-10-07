class AsyncWorkflowWorkerService {
  constructor({
    scheduler,
    workerFactory,
    workerId = null,
    pollIntervalMs = 1000,
    recoveryIntervalMs = 5000,
    clock = () => Date.now(),
    onError = () => {}
  } = {}) {
    if (!scheduler) throw new TypeError('scheduler is required');
    if (typeof workerFactory !== 'function') throw new TypeError('workerFactory is required');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) {
      throw new TypeError('pollIntervalMs must be at least 50ms');
    }
    if (!Number.isInteger(recoveryIntervalMs) || recoveryIntervalMs < pollIntervalMs) {
      throw new TypeError('recoveryIntervalMs must be >= pollIntervalMs');
    }

    this.scheduler = scheduler;
    this.workerFactory = workerFactory;
    this.workerId = workerId;
    this.pollIntervalMs = pollIntervalMs;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.clock = clock;
    this.onError = onError;
    this.running = false;
    this.timer = null;
    this.lastRecoveryAt = null;
    this.inFlight = null;
    this.stopRequested = false;
  }

  isRunning() {
    return this.running;
  }

  runOnce() {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const now = this.clock();
        if (
          typeof this.scheduler.recoverPersisted === 'function' &&
          (this.lastRecoveryAt === null || now - this.lastRecoveryAt >= this.recoveryIntervalMs)
        ) {
          await this.scheduler.recoverPersisted();
          this.lastRecoveryAt = now;
        }

        const worker = this.workerFactory(this.workerId || undefined);
        if (!worker || typeof worker.tick !== 'function') {
          throw new TypeError('workerFactory must return a worker with tick()');
        }

        return await worker.tick();
      } catch (error) {
        this.onError(error);
        return null;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  start() {
    if (this.running) return false;
    this.stopRequested = false;
    this.running = true;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    this.stopRequested = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return true;
  }

  async drain() {
    while (this.inFlight) await this.inFlight;
    return true;
  }

  async stopAndDrain() {
    const wasRunning = this.running || Boolean(this.inFlight);
    this.stop();
    await this.drain();
    return wasRunning;
  }
}

module.exports = AsyncWorkflowWorkerService;
