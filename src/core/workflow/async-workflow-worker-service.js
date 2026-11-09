const crypto = require('crypto');
const { createWorkerPersistencePrincipal } = require('../security/worker-persistence-principal');

class AsyncWorkflowWorkerService {
  constructor({
    scheduler,
    workerFactory,
    workerId = null,
    pollIntervalMs = 1000,
    recoveryIntervalMs = 5000,
    clock = () => Date.now(),
    onError = () => {},
    workerRegistry = null,
    workerTtlMs = 30000,
    workerHeartbeatIntervalMs = null,
    workerCapabilities = [],
    workerMetadata = {}
  } = {}) {
    if (!scheduler) throw new TypeError('scheduler is required');
    if (typeof workerFactory !== 'function') throw new TypeError('workerFactory is required');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) {
      throw new TypeError('pollIntervalMs must be at least 50ms');
    }
    if (!Number.isInteger(recoveryIntervalMs) || recoveryIntervalMs < pollIntervalMs) {
      throw new TypeError('recoveryIntervalMs must be >= pollIntervalMs');
    }
    if (!Number.isInteger(workerTtlMs) || workerTtlMs < 1000) {
      throw new TypeError('workerTtlMs must be at least 1000ms');
    }

    this.scheduler = scheduler;
    this.workerFactory = workerFactory;
    this.workerId = workerId || crypto.randomUUID();
    this.pollIntervalMs = pollIntervalMs;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.clock = clock;
    this.onError = onError;
    this.workerRegistry = workerRegistry;
    this.workerTtlMs = workerTtlMs;
    this.workerHeartbeatIntervalMs = workerHeartbeatIntervalMs || Math.max(1000, Math.floor(workerTtlMs / 3));
    this.workerCapabilities = [...workerCapabilities];
    this.workerPrincipal = createWorkerPersistencePrincipal({
      tenantId: this.scheduler.tenantId || 'local',
      workerId: this.workerId,
      sessionId: crypto.randomUUID(),
      capabilities: this.workerCapabilities
    });
    this.workerMetadata = { ...workerMetadata };
    this.running = false;
    this.timer = null;
    this.heartbeatTimer = null;
    this.lastRecoveryAt = null;
    this.inFlight = null;
    this.stopRequested = false;
    this.workerRegistered = false;
    this.workerRegistration = null;
  }

  isRunning() {
    return this.running;
  }

  async ensureWorkerRegistered() {
    if (!this.workerRegistry?.register) return true;
    if (this.workerRegistered) return true;
    if (!this.workerRegistration) {
      const now = this.clock();
      this.workerRegistration = Promise.resolve(
        this.workerRegistry.register({
          workerId: this.workerId,
          tenantId: this.scheduler.tenantId || 'local',
          startedAt: new Date(now).toISOString(),
          heartbeatAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.workerTtlMs).toISOString(),
          status: 'READY',
          capabilities: this.workerCapabilities,
          metadata: this.workerMetadata
        }, this.scheduler.tenantId || 'local', { workerPrincipal: this.workerPrincipal })
      ).then(() => {
        this.workerRegistered = true;
        return true;
      }).catch(error => {
        this.workerRegistration = null;
        throw error;
      });
    }
    return this.workerRegistration;
  }

  async heartbeatWorker() {
    if (!this.workerRegistry?.heartbeat || !this.workerRegistered) return null;
    const now = this.clock();
    return this.workerRegistry.heartbeat(this.workerId, {
      tenantId: this.scheduler.tenantId || 'local',
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.workerTtlMs).toISOString(),
      status: 'READY',
      workerPrincipal: this.workerPrincipal
    });
  }

  async unregisterWorker() {
    if (!this.workerRegistry?.unregister || !this.workerRegistered) return false;
    const removed = await this.workerRegistry.unregister(
      this.workerId,
      this.scheduler.tenantId || 'local',
      { workerPrincipal: this.workerPrincipal }
    );
    this.workerRegistered = false;
    return removed;
  }

  runOnce() {
    if (this.inFlight) return this.inFlight;
    if (this.stopRequested) return Promise.resolve(null);

    this.inFlight = (async () => {
      try {
        await this.ensureWorkerRegistered();
        const now = this.clock();
        if (
          typeof this.scheduler.recoverPersisted === 'function' &&
          (this.lastRecoveryAt === null || now - this.lastRecoveryAt >= this.recoveryIntervalMs)
        ) {
          await this.scheduler.recoverPersisted(this.workerId, this.workerCapabilities, this.workerPrincipal);
          this.lastRecoveryAt = now;
        }

        const worker = this.workerFactory(this.workerId, this.workerCapabilities, this.workerPrincipal);
        if (!worker || typeof worker.tick !== 'function') {
          throw new TypeError('workerFactory must return a worker with tick()');
        }
        if ((worker.workerId && worker.workerId !== this.workerId) ||
            (worker.workerPrincipal && worker.workerPrincipal !== this.workerPrincipal)) {
          throw Object.assign(new Error('Worker factory returned a different worker identity'), {
            code: 'WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'
          });
        }

        return await worker.tick();
      } catch (error) {
        this.onError(error);
        if (error?.code === 'WORKER_DURABLE_FENCING_UNSUPPORTED') {
          this.stopRequested = true;
          this.running = false;
          if (this.timer) clearInterval(this.timer);
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.timer = null;
          this.heartbeatTimer = null;
          try {
            await this.unregisterWorker();
          } catch (cleanupError) {
            this.onError(cleanupError);
          }
        }
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

    if (this.workerRegistry?.heartbeat) {
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeatWorker().catch(error => this.onError(error));
      }, this.workerHeartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
    return true;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    this.stopRequested = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    return true;
  }

  async drain() {
    while (this.inFlight) await this.inFlight;
    return true;
  }

  async stopAndDrain() {
    const wasRunning = this.running || Boolean(this.inFlight);
    this.stopRequested = true;
    this.stop();
    await this.drain();
    await this.unregisterWorker();
    return wasRunning;
  }
}

module.exports = AsyncWorkflowWorkerService;
