const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowScheduler = require('../../../../src/core/workflow/async-workflow-scheduler');
const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const withDispatchClaim = require('../../../helpers/dispatch-claim-fixture');

function payload(workflowId) {
  const instance = new WorkflowInstance({
    workflowId,
    tenantId: 'tenant-a',
    definition: new WorkflowDefinition({
      id: 'recovery-dispatch-gate',
      version: 1,
      name: 'Recovery dispatch gate',
      steps: [{ id: 'work', tool: 'work' }]
    })
  });
  instance.transition('QUEUED');
  return withDispatchClaim(instance.toJSON());
}

function scheduler({ snapshots, claimed, reconcile, releaseDispatchClaim = async () => true }) {
  const value = Object.create(AsyncWorkflowScheduler.prototype);
  value.workflowRepository = {
    async findAll() { return snapshots; },
    async claimQueued() { return claimed; },
    releaseDispatchClaim,
    async save() {}
  };
  value.missionEventRecovery = { reconcile };
  value.tenantId = 'tenant-a';
  value.maxQueueDepth = 10;
  value.dispatchWindow = 5;
  value.leaseDurationMs = 5000;
  value.agingQuantumMs = 30000;
  value.queue = [];
  value.active = new Map();
  value.sequence = 0;
  value.accepting = true;
  value.clock = () => Date.now();
  value.leaseStore = { async get() { return null; } };
  value.quotaRepository = null;
  value.quotaPolicy = null;
  return value;
}

test('recovery never dispatches workflows whose event reconciliation failed or was not observed', async () => {
  const blocked = payload('blocked-checkpoint-conflict');
  const healthy = payload('healthy-recovery');
  const concurrentlyAdded = payload('not-in-recovery-snapshot');
  const released = [];
  const value = scheduler({
    snapshots: [blocked, healthy],
    claimed: [blocked, healthy, concurrentlyAdded],
    reconcile: async workflowId => {
      if (workflowId === blocked.workflowId) {
        throw Object.assign(new Error('checkpoint changed during recovery'), {
          code: 'MISSION_EVENT_HISTORY_MISSING'
        });
      }
      return { status: 'HEALTHY' };
    },
    releaseDispatchClaim: async workflowId => {
      released.push(workflowId);
      return true;
    }
  });

  const recovered = await value.recoverPersisted('worker-a', [], {
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'session-a',
    capabilities: []
  });

  assert.equal(recovered, 1);
  assert.deepEqual(value.queue.map(item => item.instance.workflowId), [healthy.workflowId]);
  assert.deepEqual(released, [blocked.workflowId, concurrentlyAdded.workflowId]);
});

test('recovery fails closed when an unverified dispatch claim cannot be released', async () => {
  const blocked = payload('blocked-release-failure');
  const value = scheduler({
    snapshots: [blocked],
    claimed: [blocked],
    reconcile: async () => {
      throw Object.assign(new Error('checkpointed workflow lost its durable event history'), {
        code: 'WORKFLOW_CHECKPOINT_CONFLICT'
      });
    },
    releaseDispatchClaim: async () => {
      throw new Error('database unavailable');
    }
  });

  await assert.rejects(
    () => value.recoverPersisted('worker-a', [], {
      tenantId: 'tenant-a',
      workerId: 'worker-a',
      sessionId: 'session-a',
      capabilities: []
    }),
    error => error.code === 'WORKFLOW_RECOVERY_CLAIM_RELEASE_FAILED' &&
      error.workflowId === blocked.workflowId
  );
  assert.equal(value.queue.length, 0);
});

test('durable recovery refuses to claim work when snapshots cannot be enumerated', async () => {
  const value = scheduler({
    snapshots: [],
    claimed: [],
    reconcile: async () => ({ status: 'HEALTHY' })
  });
  value.workflowRepository.findAll = undefined;
  let claimCalls = 0;
  value.workflowRepository.claimQueued = async () => {
    claimCalls += 1;
    return [];
  };

  await assert.rejects(
    () => value.recoverPersisted('worker-a', [], {
      tenantId: 'tenant-a',
      workerId: 'worker-a',
      sessionId: 'session-a',
      capabilities: []
    }),
    error => error.code === 'WORKFLOW_RECOVERY_SNAPSHOT_ENUMERATION_REQUIRED'
  );
  assert.equal(claimCalls, 0);
});

test('legacy workflows without an event history retain the documented recovery path', async () => {
  const legacy = payload('legacy-without-event-history');
  const value = scheduler({
    snapshots: [legacy],
    claimed: [legacy],
    reconcile: async () => {
      throw Object.assign(new Error('no durable event stream exists for this legacy workflow'), {
        code: 'MISSION_EVENT_HISTORY_REQUIRED'
      });
    }
  });

  const recovered = await value.recoverPersisted('worker-a', [], {
    tenantId: 'tenant-a',
    workerId: 'worker-a',
    sessionId: 'session-a',
    capabilities: []
  });

  assert.equal(recovered, 1);
  assert.deepEqual(value.queue.map(item => item.instance.workflowId), [legacy.workflowId]);
});


test('scheduler refuses to dispatch a worker without a durable fencing token and releases its claim', async () => {
  const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
  const instance = new WorkflowInstance({
    workflowId: 'workflow-without-fencing',
    tenantId: 'tenant-a',
    definition: new WorkflowDefinition({
      id: 'fencing-gate', version: 1, name: 'Fencing gate',
      steps: [{ id: 'work', tool: 'work' }]
    })
  });
  instance.transition('QUEUED');
  const released = [];
  const value = Object.create(AsyncWorkflowScheduler.prototype);
  value.leaseStore = {
    async recoverExpired() {},
    async acquire(workflowId, workerId) {
      return { workflowId, workerId, leaseId: 'lease-without-token', acquiredAt: Date.now(), expiresAt: Date.now() + 5000 };
    },
    async release(workflowId, leaseId) {
      released.push(['lease', workflowId, leaseId]);
      return { released: true };
    }
  };
  value.active = new Map();
  value.maxConcurrent = 1;
  value.queue = [{ instance, availableAt: 0, deadlineAt: null, priority: 0, sequence: 1 }];
  value.sortQueue = () => {};
  value.clock = () => Date.now();
  value.cancelled = new Set();
  value.tenantId = 'tenant-a';
  value.leaseDurationMs = 5000;
  value.quotaRepository = null;
  value.workflowRepository = {
    async releaseDispatchClaim(workflowId, workerId, tenantId) {
      released.push(['claim', workflowId, workerId, tenantId]);
      return true;
    }
  };

  await assert.rejects(
    () => value.leaseAsync('worker-a', [], {
      tenantId: 'tenant-a', workerId: 'worker-a',
      sessionId: 'session-a', capabilities: []
    }),
    error => error.code === 'WORKER_DURABLE_FENCING_UNSUPPORTED'
  );
  assert.deepEqual(released, [
    ['lease', 'workflow-without-fencing', 'lease-without-token'],
    ['claim', 'workflow-without-fencing', 'worker-a', 'tenant-a']
  ]);
  assert.equal(value.queue.length, 1);
  assert.equal(value.active.size, 0);
  assert.equal(instance.state, 'QUEUED');
});
