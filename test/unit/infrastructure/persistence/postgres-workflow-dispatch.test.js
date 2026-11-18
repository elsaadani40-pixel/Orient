'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {PostgresWorkflowRepository}=require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const {createWorkerPersistencePrincipal}=require('../../../../src/core/security/worker-persistence-principal');

function makePrincipal(overrides={}) {
  return createWorkerPersistencePrincipal({
    tenantId:'tenant-a',
    workerId:'worker-a',
    sessionId:'session-a',
    capabilities:['calendar.read','web.search'],
    ...overrides
  });
}

function harness({registeredSession='session-a',claimRows=[{workflow_id:'wf-1'}]}={}) {
  const calls=[];
  let transactions=0;
  const identity=makePrincipal();
  const client={async query(sql,values=[]){
    calls.push({sql,values});
    if(sql.includes('FROM worker_nodes')) {
      const active = registeredSession === values[2];
      return {rowCount:active ? 1 : 0,rows:active ? [{capabilities:['web.search','calendar.read']}] : []};
    }
    if(sql.includes('INSERT INTO workflow_dispatch_claims')) return {rows:claimRows,rowCount:claimRows.length};
    if(sql.includes('SELECT payload FROM workflows')) return {rows:[{payload:{workflowId:'wf-1',tenantId:'tenant-a',state:'QUEUED'}}]};
    if(sql.includes('DELETE FROM workflow_dispatch_claims')) return {rows:[],rowCount:1};
    return {rows:[],rowCount:1};
  }};
  const db={
    query(){throw new Error('Worker-scoped dispatch must use transactionWithWorkerPrincipal');},
    async transactionWithWorkerPrincipal(principal,work){
      transactions+=1;
      assert.equal(principal.kind,'worker');
      return work(client,principal);
    }
  };
  return {db,calls,identity,get transactions(){return transactions;}};
}

test('durable dispatch claim is bound to the registered worker session and capabilities',async()=>{
  const h=harness();
  const repo=new PostgresWorkflowRepository(h.db,{});
  const claimed=await repo.claimQueued({
    tenantId:'tenant-a',workerId:'worker-a',limit:10,
    workerCapabilities:['web.search','calendar.read'],
    agingQuantumMs:15000,workerPrincipal:h.identity
  });
  assert.equal(claimed.length,1);
  assert.equal(claimed[0].tenantId,'tenant-a');
  const claimCall=h.calls.find(x=>x.sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.match(claimCall.sql,/FOR UPDATE SKIP LOCKED/);
  assert.match(claimCall.sql,/requiredCapabilities/);
  assert.match(claimCall.sql,/approvalBlocked/);
  assert.match(claimCall.sql,/worker_session_id/);
  assert.deepEqual(claimCall.values.slice(0,5),[
    'tenant-a',10,'worker-a',JSON.stringify(['web.search','calendar.read']),15000
  ]);
  assert.equal(claimCall.values[6],'session-a');

  const released=await repo.releaseDispatchClaim('wf-1','worker-a','tenant-a',{
    workerPrincipal:h.identity
  });
  assert.equal(released,true);
  assert.deepEqual(h.calls.at(-1).values,['tenant-a','wf-1','worker-a','session-a']);
  assert.equal(h.transactions,2);
});

test('dispatch rejects a stale worker session and mismatched worker principal',async()=>{
  const stale=harness({registeredSession:'previous-session'});
  const repo=new PostgresWorkflowRepository(stale.db,{});
  await assert.rejects(
    repo.claimQueued({
      tenantId:'tenant-a',workerId:'worker-a',workerCapabilities:['web.search'],
      workerPrincipal:stale.identity
    }),
    error=>error.code==='WORKER_SESSION_LOST'
  );
  const before=stale.calls.length;
  await assert.rejects(
    repo.claimQueued({
      tenantId:'tenant-a',workerId:'worker-b',workerCapabilities:['web.search'],
      workerPrincipal:stale.identity
    }),
    error=>error.code==='WORKER_PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(stale.calls.length,before);
});

test('dispatch refuses capabilities outside the trusted worker principal',async()=>{
  const h=harness();
  const repo=new PostgresWorkflowRepository(h.db,{});
  await assert.rejects(
    repo.claimQueued({
      tenantId:'tenant-a',workerId:'worker-a',
      workerCapabilities:['admin.execute'],
      workerPrincipal:h.identity
    }),
    error=>error.code==='WORKER_CAPABILITY_MISMATCH'
  );
  assert.equal(h.calls.length,0);
});