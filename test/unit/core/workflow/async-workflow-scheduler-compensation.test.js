const test=require('node:test');
const assert=require('node:assert/strict');
const AsyncWorkflowScheduler=require('../../../../src/core/workflow/async-workflow-scheduler');
const {WorkflowDefinition,WorkflowInstance}=require('../../../../src/core/workflow');
const {createWorkerPersistencePrincipal}=require('../../../../src/core/security/worker-persistence-principal');
function definition(){return new WorkflowDefinition({id:'compensation',version:1,name:'Compensation',steps:[{id:'step',tool:'noop',input:{}}]});}
test('async scheduler compensates lease and durable quota when persistence fails after acquisition',async()=>{
  const instance=new WorkflowInstance({definition:definition(),workflowId:'persist-failure-wf',tenantId:'tenant-compensation'});
  const leases=new Map(); const quotaCalls=[];
  let saveCalls=0; const workflowRepository={async save(){saveCalls+=1;if(saveCalls>2)throw new Error('persistence unavailable');},async findAll(){return[];}};
  const leaseRepository={async tryAcquire(){const lease={workflowId:instance.workflowId,leaseId:'lease-1',workerId:'worker-a',acquiredAt:1000,expiresAt:31000,fencingToken:1,metadata:{}};leases.set(instance.workflowId,lease);return lease;},async delete(){leases.clear();return true;},async findByWorkflowId(id){return leases.get(id)||null;},async findAll(){return [...leases.values()];}};
  const quotaRepository={async reserveWorkflow(){return{};},async promoteWorkflow(){return{};},async releaseWorkflow(args){quotaCalls.push(args);return true;}};
  const scheduler=new AsyncWorkflowScheduler({tenantId:'tenant-compensation',workflowRepository,leaseRepository,quotaRepository,quotaPolicy:{toJSON(){return{};}},clock:()=>1000,leaseDurationMs:30000});
  await scheduler.enqueueDurable(instance);
  const workerPrincipal=createWorkerPersistencePrincipal({tenantId:'tenant-compensation',workerId:'worker-a',sessionId:'session-compensation',capabilities:[]});
  await assert.rejects(()=>scheduler.leaseAsync('worker-a',[],workerPrincipal),/persistence unavailable/);
  assert.equal(scheduler.active.size,0,'active record leaked');
  assert.equal(leases.size,0,'durable lease leaked');
  assert.equal(instance.state,'QUEUED','workflow state was not restored after failed persistence');
  assert.equal(instance.metadata.fencingToken,undefined,'stale fencing token leaked into the queued instance');
  assert.equal(scheduler.queue.length,1,'workflow was not returned to the dispatch queue');
  assert.equal(quotaCalls.length,1,'quota reservation leaked');
  assert.equal(quotaCalls[0].workflowId,instance.workflowId);
});


test('async scheduler uses the active lease principal for workflow persistence', async () => {
  const workflowId = 'persist-active-lease';
  const tenantId = 'tenant-persist-active';
  const principal = createWorkerPersistencePrincipal({
    tenantId, workerId: 'worker-a', sessionId: 'session-a',
    workflowId, leaseId: 'lease-a', fencingToken: 88
  });
  let saved = null;
  const workflowRepository = {
    async save(...args) { saved = args; }
  };
  const scheduler = new AsyncWorkflowScheduler({ tenantId, workflowRepository });
  const instance = {
    workflowId, tenantId, state: 'RUNNING', metadata: { fencingToken: 88 }
  };
  scheduler.active.set(workflowId, { workerPrincipal: principal });
  await scheduler.persistAsync(instance);
  assert.equal(saved[0], instance);
  assert.equal(saved[1], tenantId);
  assert.equal(saved[2].workerPrincipal, principal);
});


test('async scheduler reconciles durable mission history before claiming queued work', async () => {
  const calls = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-recovery',
    workflowRepository: {
      async findAll() {
        calls.push('snapshots');
        return [{ workflowId: 'wf-recovery', tenantId: 'tenant-recovery', state: 'QUEUED', metadata: {} }];
      },
      async claimQueued() {
        calls.push('claim');
        return [];
      }
    },
    missionEventRecovery: {
      async reconcile(workflowId, tenantId) {
        calls.push(['reconcile', workflowId, tenantId]);
        return { status: 'HEALTHY' };
      }
    }
  });
  const recovered = await scheduler.recoverPersisted('worker-recovery', []);
  assert.equal(recovered, 0);
  assert.deepEqual(calls, [
    'snapshots',
    ['reconcile', 'wf-recovery', 'tenant-recovery'],
    'claim'
  ]);
});

test('async scheduler fails closed on corrupt durable mission history before dispatch', async () => {
  let claims = 0;
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-recovery',
    workflowRepository: {
      async findAll() {
        return [{ workflowId: 'wf-corrupt', tenantId: 'tenant-recovery', state: 'QUEUED', metadata: {} }];
      },
      async claimQueued() { claims += 1; return []; }
    },
    missionEventRecovery: {
      async reconcile() {
        throw Object.assign(new Error('event sequence gap'), { code: 'MISSION_EVENT_SEQUENCE_GAP' });
      }
    }
  });
  await assert.rejects(
    () => scheduler.recoverPersisted('worker-recovery', []),
    error => error.code === 'MISSION_EVENT_SEQUENCE_GAP'
  );
  assert.equal(claims, 0);
});


test('async queued cancellation is appended to mission history before snapshot persistence', async () => {
  const definition = new WorkflowDefinition({
    id: 'cancel-durable',
    version: 1,
    name: 'Cancel durable',
    steps: [{ id: 'work', tool: 'work' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'wf-cancel-durable', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  const calls = [];
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-a',
    workflowRepository: { async save() { calls.push('snapshot'); } },
    missionEventSink: {
      async recordSnapshot(snapshot, reason, options) {
        calls.push(['event', snapshot.cancelRequested, snapshot.state, reason, options.persist]);
      }
    }
  });
  scheduler.queue.push({ instance, priority: 0 });
  assert.equal(await scheduler.cancelAsync(instance.workflowId), true);
  assert.deepEqual(calls, [
    ['event', true, 'CANCELLED', 'workflow_cancel_requested', false],
    'snapshot'
  ]);
  assert.equal(scheduler.queue.length, 0);
});

test('async active cancellation records intent without bypassing the worker lease fence', async () => {
  const definition = new WorkflowDefinition({
    id: 'cancel-active-durable',
    version: 1,
    name: 'Cancel active durable',
    steps: [{ id: 'work', tool: 'work' }]
  });
  const instance = new WorkflowInstance({ definition, workflowId: 'wf-cancel-active', tenantId: 'tenant-a' });
  instance.transition('QUEUED');
  instance.transition('RUNNING');
  const calls = [];
  const active = { instance, cancelled: false };
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-a',
    workflowRepository: { async save() { calls.push('snapshot'); } },
    missionEventSink: {
      async recordSnapshot(snapshot, reason, options) {
        calls.push(['event', snapshot.cancelRequested, snapshot.state, reason, options.persist]);
      }
    }
  });
  scheduler.active.set(instance.workflowId, active);
  assert.equal(await scheduler.cancelAsync(instance.workflowId), true);
  assert.equal(active.cancelled, true);
  assert.deepEqual(calls, [
    ['event', true, 'RUNNING', 'workflow_cancel_requested', false]
  ]);
});


test('async enqueue persists before exposing a workflow to the in-memory queue', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'enqueue-persist-failure', tenantId: 'tenant-a' });
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-a',
    workflowRepository: { async save() { throw new Error('snapshot write failed'); } }
  });
  await assert.rejects(() => scheduler.enqueueDurable(instance), /snapshot write failed/);
  assert.equal(scheduler.queue.length, 0);
  assert.equal(scheduler.active.size, 0);
  assert.equal(instance.state, 'QUEUED');
});

test('async enqueue does not rewrite a workflow already committed with its initial event history', async () => {
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'enqueue-already-committed', tenantId: 'tenant-a' });
  let saves = 0;
  const scheduler = new AsyncWorkflowScheduler({
    tenantId: 'tenant-a',
    workflowRepository: { async save() { saves += 1; } }
  });
  await scheduler.enqueueDurable(instance, { durableAlreadyPersisted: true });
  assert.equal(saves, 0);
  assert.equal(scheduler.queue.length, 1);
  assert.equal(scheduler.queue[0].instance, instance);
});
