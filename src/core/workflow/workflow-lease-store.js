const crypto = require('crypto');
const AppError = require('../errors/AppError');

class WorkflowLeaseStore {
  constructor({ repository = null, clock = () => Date.now(), leaseDurationMs = 30000 } = {}) {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1000) {
      throw new AppError('leaseDurationMs must be at least 1000ms', 400, 'LEASE_INVALID_DURATION');
    }
    this.repository = repository;
    this.clock = clock;
    this.leaseDurationMs = leaseDurationMs;
    this.memory = new Map();
  }

  now() {
    return this.clock();
  }

  acquire(workflowId, workerId = crypto.randomUUID(), metadata = {}) {
    if (!workflowId) throw new AppError('workflowId is required', 400, 'LEASE_WORKFLOW_REQUIRED');
    const now = this.now();
    const lease = {
      workflowId,
      leaseId: crypto.randomUUID(),
      workerId,
      acquiredAt: now,
      expiresAt: now + this.leaseDurationMs,
      metadata: { ...metadata }
    };

    // Durable repositories may provide an atomic acquisition primitive.
    // This is required for multi-process workers; a read-then-write sequence
    // can otherwise allow two workers to acquire the same workflow.
    if (this.repository?.tryAcquire) {
      const acquired = this.repository.tryAcquire(lease);
      if (!acquired) {
        throw new AppError('Workflow lease is already held', 409, 'WORKFLOW_LEASE_HELD');
      }
    } else {
      const current = this.get(workflowId);
      if (current && current.expiresAt > now) {
        throw new AppError('Workflow lease is already held', 409, 'WORKFLOW_LEASE_HELD');
      }
      this.persist(lease);
    }

    this.memory.set(workflowId, lease);
    return { ...lease };
  }

  renew(workflowId, leaseId) {
    const lease = this.require(workflowId, leaseId);
    const expiresAt = this.now() + this.leaseDurationMs;

    if (this.repository?.renewIfOwned) {
      const renewed = this.repository.renewIfOwned(
        workflowId,
        leaseId,
        expiresAt
      );
      if (!renewed) {
        this.memory.delete(workflowId);
        throw new AppError(
          'Workflow lease is not owned by this worker',
          409,
          'WORKFLOW_LEASE_NOT_OWNER'
        );
      }
      lease.expiresAt = expiresAt;
      this.memory.set(workflowId, lease);
      return { ...lease };
    }

    lease.expiresAt = expiresAt;
    this.memory.set(workflowId, lease);
    this.persist(lease);
    return { ...lease };
  }

  release(workflowId, leaseId) {
    const lease = this.require(workflowId, leaseId);
    this.memory.delete(workflowId);
    if (this.repository?.delete) this.repository.delete(workflowId, leaseId);
    return { ...lease };
  }

  get(workflowId) {
    const local = this.memory.get(workflowId);
    if (local) return local;
    const persisted = this.repository?.findByWorkflowId?.(workflowId) || null;
    if (persisted) this.memory.set(workflowId, persisted);
    return persisted;
  }

  recoverExpired() {
    const now = this.now();
    const expired = [];
    for (const lease of this.all()) {
      if (lease.expiresAt <= now) {
        this.memory.delete(lease.workflowId);
        if (this.repository?.deleteExpired) {
          this.repository.deleteExpired(lease.workflowId, lease.leaseId, now);
        }
        expired.push({ ...lease });
      }
    }
    return expired;
  }

  // Merge durable ownership without allowing stale local leases to override it.\n  all() {
    const persisted = this.repository?.findAll?.() || [];
    const merged = new Map(persisted.map(item => [item.workflowId, item]));
    for (const [id, lease] of this.memory) {
      if (!merged.has(id)) merged.set(id, lease);
    }
    return [...merged.values()];
  }

  require(workflowId, leaseId) {
    const lease = this.get(workflowId);
    if (!lease || lease.leaseId !== leaseId) {
      throw new AppError(
        'Workflow lease is not owned by this worker',
        409,
        'WORKFLOW_LEASE_NOT_OWNER'
      );
    }
    if (lease.expiresAt <= this.now()) {
      this.memory.delete(workflowId);
      throw new AppError(
        'Workflow lease has expired',
        409,
        'WORKFLOW_LEASE_EXPIRED'
      );
    }
    return lease;
  }

  persist(lease) {
    if (this.repository?.save) this.repository.save(lease);
  }
}

module.exports = WorkflowLeaseStore;
