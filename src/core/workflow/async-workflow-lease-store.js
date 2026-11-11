'use strict';

const crypto = require('crypto');
const AppError = require('../errors/AppError');

class AsyncWorkflowLeaseStore {
  constructor({ repository = null, clock = () => Date.now(), leaseDurationMs = 30000, tenantId = null } = {}) {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1000) {
      throw new AppError('leaseDurationMs must be at least 1000ms', 400, 'LEASE_INVALID_DURATION');
    }
    this.repository = repository;
    this.clock = clock;
    this.leaseDurationMs = leaseDurationMs;
    this.tenantId = tenantId;
    this.memory = new Map();
  }

  now() { return this.clock(); }

  createLease(workflowId, workerId, metadata) {
    const now = this.now();
    return {
      workflowId, leaseId: crypto.randomUUID(), workerId,
      acquiredAt: now, expiresAt: now + this.leaseDurationMs,
      metadata: { ...metadata, ...(this.tenantId ? { tenantId: this.tenantId } : {}) }
    };
  }

  rememberLease(lease) {
    if (lease.fencingToken !== undefined) lease.metadata = { ...lease.metadata, fencingToken: lease.fencingToken };
    this.memory.set(lease.workflowId, lease);
    return { ...lease };
  }

  async acquire(workflowId, workerId = crypto.randomUUID(), metadata = {}, workerPrincipal = null) {
    if (!workflowId) throw new AppError('workflowId is required', 400, 'LEASE_WORKFLOW_REQUIRED');
    let lease = this.createLease(workflowId, workerId, metadata);
    if (this.repository?.tryAcquire) {
      const acquired = await this.repository.tryAcquire(lease, this.tenantId, { workerPrincipal });
      if (!acquired) throw new AppError('Workflow lease is already held', 409, 'WORKFLOW_LEASE_HELD');
      lease = { ...lease, ...acquired };
    } else {
      const current = await this.get(workflowId);
      if (current && current.expiresAt > lease.acquiredAt) throw new AppError('Workflow lease is already held', 409, 'WORKFLOW_LEASE_HELD');
      await this.persist(lease, workerPrincipal);
    }
    return this.rememberLease(lease);
  }

  async acquireClaimed(workflowId, workerId, metadata = {}, dispatchClaim, workerPrincipal = null) {
    if (!workflowId || !dispatchClaim) throw new AppError('Exact dispatch claim is required', 400, 'WORKFLOW_DISPATCH_CLAIM_REQUIRED');
    if (typeof this.repository?.tryAcquireClaimed !== 'function') throw new AppError('Atomic PostgreSQL claim-to-lease handoff is required', 503, 'WORKFLOW_ATOMIC_CLAIM_HANDOFF_REQUIRED');
    const lease = this.createLease(workflowId, workerId, metadata);
    const acquired = await this.repository.tryAcquireClaimed(lease, dispatchClaim, this.tenantId, { workerPrincipal });
    if (!acquired) throw new AppError('Workflow lease is already held or dispatch claim is no longer valid', 409, 'WORKFLOW_LEASE_HELD');
    return this.rememberLease({ ...lease, ...acquired });
  }

  async renew(workflowId, leaseId, workerPrincipal = null) {
    const lease = await this.require(workflowId, leaseId);
    const expiresAt = this.now() + this.leaseDurationMs;
    if (this.repository?.renewIfOwned) {
      if (!await this.repository.renewIfOwned(workflowId, leaseId, expiresAt, this.now(), this.tenantId, { workerPrincipal })) {
        this.memory.delete(workflowId);
        throw new AppError('Workflow lease is not owned by this worker session', 409, 'WORKFLOW_LEASE_NOT_OWNER');
      }
    } else {
      await this.persist({ ...lease, expiresAt }, workerPrincipal);
    }
    lease.expiresAt = expiresAt;
    this.memory.set(workflowId, lease);
    return { ...lease };
  }

  async assertCurrent(workflowId, leaseId, fencingToken, workerPrincipal = null) {
    const lease = await this.get(workflowId);
    if (!lease || lease.leaseId !== leaseId ||
        Number(lease.fencingToken) !== Number(fencingToken) || lease.expiresAt <= this.now()) {
      throw new AppError('Workflow fencing token is no longer current', 409, 'WORKFLOW_FENCING_REJECTED');
    }
    if (this.repository?.assertCurrent &&
        !await this.repository.assertCurrent(workflowId, leaseId, fencingToken, this.now(), this.tenantId, { workerPrincipal })) {
      this.memory.delete(workflowId);
      throw new AppError('Workflow fencing token is no longer current', 409, 'WORKFLOW_FENCING_REJECTED');
    }
    return true;
  }

  async release(workflowId, leaseId, workerPrincipal = null) {
    const lease = await this.require(workflowId, leaseId);
    let released = true;
    try {
      if (this.repository?.delete) {
        released = await this.repository.delete(workflowId, leaseId, this.tenantId, { workerPrincipal });
      }
      return { ...lease, released };
    } finally {
      // A failed ownership check must not leave a stale process-local lease shadow.
      // The durable row remains authoritative and can be re-read on the next lookup.
      this.memory.delete(workflowId);
    }
  }

  async get(workflowId) {
    const local = this.memory.get(workflowId);
    if (local && this.tenantMatches(local)) return local;
    const persisted = this.repository?.findByWorkflowId
      ? await this.repository.findByWorkflowId(workflowId, this.tenantId)
      : null;
    if (persisted && this.tenantMatches(persisted)) this.memory.set(workflowId, persisted);
    return persisted && this.tenantMatches(persisted) ? persisted : null;
  }

  async recoverExpired() {
    const now = this.now();
    const expired = [];
    for (const lease of await this.all()) {
      if (lease.expiresAt <= now) {
        this.memory.delete(lease.workflowId);
        if (this.repository?.deleteExpired) {
          await this.repository.deleteExpired(lease.workflowId, lease.leaseId, now, this.tenantId);
        }
        expired.push({ ...lease });
      }
    }
    return expired;
  }

  async all() {
    const persisted = this.repository?.findAll ? await this.repository.findAll({ tenantId: this.tenantId }) : [];
    const merged = new Map(persisted.map(lease => [lease.workflowId, lease]));
    for (const [id, lease] of this.memory) if (!merged.has(id)) merged.set(id, lease);
    return [...merged.values()];
  }

  tenantMatches(lease) {
    return !this.tenantId || lease?.metadata?.tenantId === this.tenantId;
  }

  async require(workflowId, leaseId) {
    const lease = await this.get(workflowId);
    if (!lease || lease.leaseId !== leaseId || !this.tenantMatches(lease)) {
      throw new AppError('Workflow lease is not owned by this worker', 409, 'WORKFLOW_LEASE_NOT_OWNER');
    }
    if (lease.expiresAt <= this.now()) {
      this.memory.delete(workflowId);
      throw new AppError('Workflow lease has expired', 409, 'WORKFLOW_LEASE_EXPIRED');
    }
    return lease;
  }

  async persist(lease, workerPrincipal = null) {
    if (this.repository?.save) await this.repository.save(lease, this.tenantId, { workerPrincipal });
  }
}

module.exports = AsyncWorkflowLeaseStore;
