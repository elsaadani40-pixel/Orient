const AppError = require('../errors/AppError');
const WorkflowLeaseStore = require('./workflow-lease-store');
const WorkflowInstance = require('./workflow-instance');

class WorkflowScheduler {
  constructor({
    maxConcurrent = 1,
    clock = () => Date.now(),
    leaseStore = null,
    leaseDurationMs = 30000,
    maxRetries = 2,
    baseBackoffMs = 250,
    maxBackoffMs = 30000,
    workflowRepository = null,
    tenantId = null,
    maxQueueDepth = 1000
  } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new AppError(
        'maxConcurrent must be positive',
        400,
        'SCHEDULER_INVALID_LIMIT'
      );
    }
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 1) {
      throw new AppError('maxQueueDepth must be positive', 400, 'SCHEDULER_INVALID_QUEUE_LIMIT');
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new AppError(
        'maxRetries must be non-negative',
        400,
        'SCHEDULER_INVALID_RETRIES'
      );
    }

    this.maxConcurrent = maxConcurrent;
    this.maxQueueDepth = maxQueueDepth;
    this.accepting = true;
    this.clock = clock;
    this.maxRetries = maxRetries;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.workflowRepository = workflowRepository;
    this.tenantId = tenantId;
    this.queue = [];
    this.active = new Map();
    this.cancelled = new Set();
    this.sequence = 0;
    this.leaseStore =
      leaseStore ||
      new WorkflowLeaseStore({
        clock,
          leaseDurationMs,
        tenantId
      });
  }

  enqueue(
    instance,
    { priority = 0, deadlineAt = null, delayMs = 0 } = {}
  ) {
    if (!this.accepting) {
      throw new AppError('Workflow scheduler is shutting down', 503, 'SCHEDULER_SHUTTING_DOWN');
    }

    if (!instance) {
      throw new AppError(
        'Workflow instance required',
        400,
        'SCHEDULER_WORKFLOW_REQUIRED'
      );
    }

    if (this.tenantId && instance.tenantId !== this.tenantId) {
      throw new AppError(
        'Workflow tenant does not match scheduler tenant',
        403,
        'WORKFLOW_TENANT_MISMATCH'
      );
    }

    if (
      instance.state === 'CREATED' ||
      instance.state === 'WAITING' ||
      instance.state === 'RECOVERING'
    ) {
      instance.transition('QUEUED');
    } else if (instance.state !== 'QUEUED') {
      throw new AppError(
        'Workflow is not queueable from its current state',
        409,
        'SCHEDULER_INVALID_STATE'
      );
    }

    if (this.queue.length >= this.maxQueueDepth) {
      throw new AppError('Workflow queue capacity exceeded', 429, 'SCHEDULER_QUEUE_FULL');
    }

    instance.setDeadline(deadlineAt);
    this.persist(instance);
    const now = this.clock();

    this.queue.push({
      instance,
      priority,
      sequence: ++this.sequence,
      enqueuedAt: now,
      availableAt: now + Math.max(0, delayMs),
      deadlineAt
    });

    this.sortQueue();
    return instance;
  }

  sortQueue() {
    const now = this.clock();

    this.queue.sort((a, b) => {
      const aReady = a.availableAt <= now;
      const bReady = b.availableAt <= now;

      if (aReady !== bReady) return aReady ? -1 : 1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.sequence - b.sequence;
    });
  }

  recoverPersisted() {
    if (!this.workflowRepository?.findAll) return 0;

    let recovered = 0;
    const now = this.clock();
    const persisted = this.workflowRepository.findAll({ tenantId: this.tenantId });

    for (const payload of persisted) {
      if (!payload || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(payload.state)) {
        continue;
      }

      const existing = this.queue.some(
        (item) => item.instance.workflowId === payload.workflowId
      ) || this.active.has(payload.workflowId);

      if (existing) continue;

      const durableLease = this.leaseStore.get(payload.workflowId);
      if (durableLease && durableLease.expiresAt > now) {
        continue;
      }

      const instance = WorkflowInstance.fromJSON(payload);

      if (instance.state === 'RUNNING') {
        instance.recoverFromLeaseLoss('LEASE_EXPIRED', () => new Date(now));
        this.persist(instance);
      }

      if (
        instance.state === 'QUEUED' ||
        instance.state === 'WAITING' ||
        instance.state === 'RECOVERING'
      ) {
        this.enqueue(instance, {
          priority: Number(instance.metadata?.priority || 0),
          deadlineAt: instance.deadlineAt,
          delayMs: 0
        });
        recovered += 1;
      }
    }

    return recovered;
  }

  cancel(workflowId) {
    const queued = this.queue.find(
      (item) => item.instance.workflowId === workflowId
    );
    const active = this.active.get(workflowId);

    if (!queued && !active && this.workflowRepository?.requestCancellation) {
      const requested = this.workflowRepository.requestCancellation(workflowId, this.tenantId);
      if (!requested) return false;
      this.cancelled.add(workflowId);
      return true;
    }
    if (!queued && !active) return false;

    if (queued) {
      queued.instance.requestCancel();
      queued.instance.transition('CANCELLED');
      this.persist(queued.instance);
      this.queue = this.queue.filter(
        (item) => item.instance.workflowId !== workflowId
      );
    }

    if (active) {
      active.cancelled = true;
      active.instance.requestCancel();
      if (this.workflowRepository?.save) this.persist(active.instance);
    }

    this.cancelled.add(workflowId);
    return true;
  }

  lease(workerId = 'worker') {
    this.leaseStore.recoverExpired();

    if (this.active.size >= this.maxConcurrent) return null;

    this.sortQueue();
    const now = this.clock();

    while (this.queue.length) {
      const item = this.queue.shift();
      const instance = item.instance;

      if (
        this.cancelled.has(instance.workflowId) ||
        instance.cancelRequested
      ) {
        if (instance.state !== 'CANCELLED') {
          instance.transition('CANCELLED');
        }
        this.persist(instance);
        continue;
      }

      if (item.availableAt > now) {
        this.queue.unshift(item);
        return null;
      }

      if (
        item.deadlineAt &&
        new Date(item.deadlineAt).getTime() <= now
      ) {
        if (instance.state !== 'FAILED') {
          instance.transition('FAILED');
        }
        instance.metadata.deadlineExceeded = true;
        instance.metadata.failureCode = 'WORKFLOW_DEADLINE_EXCEEDED';
        this.persist(instance);
        continue;
      }

      let lease;
      try {
        lease = this.leaseStore.acquire(
          instance.workflowId,
          workerId,
          {
            tenantId: instance.tenantId,
            workflowId: instance.workflowId
          }
        );
      } catch (error) {
        if (error?.code === 'WORKFLOW_LEASE_HELD') {
          // Durable ownership belongs to another worker. Keep this
          // workflow queued instead of dropping it or stealing the lease.
          this.queue.push(item);
          this.sortQueue();
          continue;
        }
        throw error;
      }

      const previousState = instance.state;
      if (lease.fencingToken !== undefined) {
        instance.metadata = { ...instance.metadata, fencingToken: lease.fencingToken };
      }
      try {
        instance.transition('RUNNING');
      } catch (error) {
        this.leaseStore.release(
          instance.workflowId,
          lease.leaseId
        );
        throw error;
      }

      const record = {
        workflowId: instance.workflowId,
        instance,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        fencingToken: lease.fencingToken,
        issuedAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        deadlineAt: item.deadlineAt,
        cancelled: false,
        previousState
      };

      this.active.set(record.workflowId, record);
      return record;
    }

    return null;
  }

  assertCurrent(workflowId, leaseId, fencingToken) {
    const active = this.active.get(workflowId);
    if (!active || active.leaseId !== leaseId || (fencingToken !== undefined && Number(active.fencingToken) !== Number(fencingToken))) {
      throw new AppError('Current workflow fencing token is invalid', 409, 'WORKFLOW_FENCING_REJECTED');
    }
    if (fencingToken !== undefined) this.leaseStore.assertCurrent(workflowId, leaseId, fencingToken);
    return true;
  }

  renew(workflowId, leaseId) {
    const active = this.active.get(workflowId);

    if (!active || active.leaseId !== leaseId) {
      throw new AppError(
        'Active workflow lease not found',
        409,
        'WORKFLOW_LEASE_NOT_FOUND'
      );
    }

    const renewed = this.leaseStore.renew(workflowId, leaseId);
    active.expiresAt = renewed.expiresAt;
    return active;
  }

  release(workflowId, leaseId = null) {
    const active = this.active.get(workflowId);
    if (!active) return false;

    const ownedLeaseId = leaseId || active.leaseId;
    this.leaseStore.release(workflowId, ownedLeaseId);
    this.active.delete(workflowId);
    return true;
  }

  retry(instance, { priority = 0, error, delayMs = null } = {}) {
    const nextAttempt = instance.retry.attempt + 1;

    if (nextAttempt > this.maxRetries) return false;

    instance.retry.attempt = nextAttempt;
    instance.retry.lastError = {
      code: error?.code || 'WORKFLOW_RETRY',
      message: error?.message || String(error)
    };

    const backoff =
      delayMs == null
        ? Math.min(
            this.maxBackoffMs,
            this.baseBackoffMs * 2 ** (nextAttempt - 1)
          )
        : Math.max(0, delayMs);

    instance.retry.nextAttemptAt = new Date(
      this.clock() + backoff
    ).toISOString();

    instance.resetStepForRetry(instance.metadata.failedStepId);

    if (instance.state === 'RUNNING') {
      instance.transition('WAITING');
    }

    this.enqueue(instance, {
      priority,
      deadlineAt: instance.deadlineAt,
      delayMs: backoff
    });

    return true;
  }

  depth() {
    return this.queue.length;
  }

  shutdown({ cancelQueued = false } = {}) {
    this.accepting = false;
    if (cancelQueued) {
      for (const item of this.queue) {
        if (item.instance.state !== 'CANCELLED') {
          item.instance.requestCancel();
          item.instance.transition('CANCELLED');
          this.persist(item.instance);
        }
      }
      this.queue = [];
    }
    return this.snapshot();
  }

  persist(instance) {
    if (this.workflowRepository?.save) {
      this.workflowRepository.save(instance);
    }
  }

  activeCount() {
    return this.active.size;
  }

  snapshot() {
    return {
      queued: this.queue.length,
      active: this.active.size,
      maxConcurrent: this.maxConcurrent,
      leases: this.leaseStore.all()
    };
  }
}

module.exports = WorkflowScheduler;
