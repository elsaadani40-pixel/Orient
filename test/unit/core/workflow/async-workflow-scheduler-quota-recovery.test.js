'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AsyncWorkflowScheduler = require('../../../../src/core/workflow/async-workflow-scheduler');
const { WorkflowDefinition, WorkflowInstance } = require('../../../../src/core/workflow');
const withDispatchClaim = require('../../../helpers/dispatch-claim-fixture');

function createQueuedPayload(workflowId) {
  const definition = new WorkflowDefinition({
    id: 'quota-recovery',
    version: 1,
    name: 'Quota recovery',
    steps: [{ id: 'step', tool: 'noop', input: {} }]
  });
  const instance = new WorkflowInstance({ definition, workflowId, tenantId: 'tenant-quota-recovery' });
  instance.transition('QUEUED');
  return withDispatchClaim(instance.toJSON());
}

test('recovery enqueue failure preserves durable quota reservation and releases only the exact dispatch claim', async () => {
  const recoveredPayload = createQueuedPayload('recovered-workflow');
  const competingWorkflow = new WorkflowInstance({
    definition: new WorkflowDefinition({
      id: 'quota-recovery-contender',
      version: 1,
      name: 'Quota recovery contender',
      steps: [{ id: 'step', tool: 'noop', input: {} }]
    }),
    workflowId: 'competing-workflow',
    tenantId: 'tenant-quota-recovery'
  });
  const calls = [];
  let scheduler;

  const workflowRepository = {
    async claimQueued() { return [recoveredPayload]; },
    async releaseDispatchClaim(workflowId, workerId, tenantId, options) {
      calls.push({ type: 'release-claim', workflowId, workerId, tenantId, claim: options.claim });
      return true;
    }
  };

  const quotaRepository = {
    async recoverWorkflow(args) {
      calls.push({ type: 'recover-quota', ...args });
      return { tenantId: args.tenantId, workflowId: args.workflowId, state: 'QUEUED' };
    },
    async reserveWorkflow(args) {
      calls.push({ type: 'reserve-quota', ...args });
      // Model a concurrent enqueue consuming the last local queue slot after
      // the recovery capacity check but before enqueuePersisted reserves it.
      scheduler.reserveEnqueue(competingWorkflow);
      return { tenantId: args.tenantId, workflowId: args.workflowId, state: 'QUEUED' };
    },
    async releaseWorkflow(args) {
      calls.push({ type: 'release-quota', ...args });
      return true;
    }
  };

  scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-quota-recovery',
    workflowRepository,
    quotaRepository,
    quotaPolicy: {},
    maxConcurrent: 1,
    maxQueueDepth: 1,
    dispatchWindow: 1
  });

  await assert.rejects(
    () => scheduler.recoverPersisted('worker-a', []),
    error => error.code === 'SCHEDULER_QUEUE_FULL'
  );

  assert.equal(scheduler.queue.length, 0);
  assert.equal(scheduler.pendingEnqueues.get('competing-workflow') !== undefined, true);
  assert.equal(calls.filter(call => call.type === 'recover-quota').length, 1);
  assert.equal(calls.filter(call => call.type === 'reserve-quota').length, 1);
  assert.equal(calls.filter(call => call.type === 'release-quota').length, 0,
    'recovery must not delete the durable reservation for a still-persisted workflow');
  const claimReleases = calls.filter(call => call.type === 'release-claim');
  assert.equal(claimReleases.length, 1);
  assert.equal(claimReleases[0].workflowId, 'recovered-workflow');
  assert.equal(claimReleases[0].workerId, recoveredPayload.dispatchClaim.workerId);
  assert.deepEqual(claimReleases[0].claim, recoveredPayload.dispatchClaim);
});

test('recovery fails closed when PostgreSQL quota recovery fails and releases only the exact dispatch claim', async () => {
  const payload = createQueuedPayload('quota-recovery-db-failure');
  const databaseError = Object.assign(new Error('simulated PostgreSQL connection loss'), { code: '08006' });
  const calls = [];
  const workflowRepository = {
    async claimQueued() { return [payload]; },
    async releaseDispatchClaim(workflowId, workerId, tenantId, options) {
      calls.push({ workflowId, workerId, tenantId, claim: options.claim });
      return true;
    }
  };
  let reserveCalls = 0;
  const quotaRepository = {
    async recoverWorkflow() { throw databaseError; },
    async reserveWorkflow() { reserveCalls += 1; }
  };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-quota-recovery',
    workflowRepository,
    quotaRepository,
    quotaPolicy: {},
    maxConcurrent: 1,
    maxQueueDepth: 2,
    dispatchWindow: 1
  });

  await assert.rejects(
    () => scheduler.recoverPersisted('worker-a', []),
    error => error === databaseError
  );
  assert.equal(reserveCalls, 0, 'a failed recovery must not reserve or enqueue work');
  assert.equal(scheduler.queue.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflowId, payload.workflowId);
  assert.equal(calls[0].workerId, 'worker-a');
  assert.deepEqual(calls[0].claim, payload.dispatchClaim);
});

test('post-claim lease lookup and snapshot hydration failures release only the exact claim', async () => {
  const scenarios = [
    {
      name: 'lease lookup rejection with successful claim cleanup',
      payload: createQueuedPayload('lease-lookup-rejection'),
      leaseError: Object.assign(new Error('simulated lease repository outage'), { code: '08006' }),
      releaseResult: true,
      expectedError: error => error.code === '08006' && error.message === 'simulated lease repository outage',
      expectedCleanupError: null
    },
    {
      name: 'malformed snapshot with a false exact-claim cleanup result',
      payload: createQueuedPayload('malformed-recovery-snapshot'),
      releaseResult: false,
      expectedError: error => error.code === 'WORKFLOW_DEFINITION_SNAPSHOT_REQUIRED',
      expectedCleanupError: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_FAILED'
    },
    {
      name: 'lease lookup rejection while exact-claim cleanup itself throws',
      payload: createQueuedPayload('lease-lookup-cleanup-failure'),
      leaseError: Object.assign(new Error('simulated lease repository outage'), { code: '08006' }),
      releaseError: Object.assign(new Error('simulated claim release outage'), { code: '08006' }),
      expectedError: error => error.code === '08006' && error.message === 'simulated lease repository outage',
      expectedCleanupError: 'WORKFLOW_RECOVERY_CLAIM_RELEASE_FAILED'
    }
  ];

  for (const scenario of scenarios) {
    if (scenario.name.startsWith('malformed snapshot')) {
      delete scenario.payload.definition;
    }
    const releaseCalls = [];
    const workflowRepository = {
      async claimQueued() { return [scenario.payload]; },
      async releaseDispatchClaim(workflowId, workerId, tenantId, options) {
        releaseCalls.push({ workflowId, workerId, tenantId, claim: options.claim });
        if (scenario.releaseError) throw scenario.releaseError;
        return scenario.releaseResult;
      }
    };
    const leaseRepository = {
      async findByWorkflowId() {
        if (scenario.leaseError) throw scenario.leaseError;
        return null;
      }
    };
    const scheduler = new AsyncWorkflowScheduler({
      tenantId: 'tenant-quota-recovery',
      workflowRepository,
      leaseRepository,
      quotaPolicy: {},
      maxConcurrent: 1,
      maxQueueDepth: 2,
      dispatchWindow: 1
    });

    await assert.rejects(
      () => scheduler.recoverPersisted('worker-a', []),
      error => {
        assert.equal(scenario.expectedError(error), true, scenario.name);
        if (scenario.expectedCleanupError) {
          assert.equal(error.dispatchClaimCleanupError?.code, scenario.expectedCleanupError, scenario.name);
        } else {
          assert.equal(error.dispatchClaimCleanupError, undefined, scenario.name);
        }
        return true;
      }
    );

    assert.equal(scheduler.queue.length, 0, scenario.name);
    assert.equal(releaseCalls.length, 1, scenario.name);
    assert.equal(releaseCalls[0].workflowId, scenario.payload.workflowId, scenario.name);
    assert.equal(releaseCalls[0].workerId, 'worker-a', scenario.name);
    assert.equal(releaseCalls[0].tenantId, 'tenant-quota-recovery', scenario.name);
    assert.deepEqual(releaseCalls[0].claim, scenario.payload.dispatchClaim, scenario.name);
  }
});
