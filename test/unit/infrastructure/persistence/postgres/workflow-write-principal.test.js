'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PostgresWorkflowRepository}=require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const {createWorkerPersistencePrincipal}=require('../../../../../src/core/security/worker-persistence-principal');

function identity(overrides={}) {
  return createWorkerPersistencePrincipal({
    tenantId:'tenant-a',workerId:'worker-a',sessionId:'session-a',
    capabilities:[],workflowId:'workflow-a',leaseId:'lease-a',fencingToken:17,
    ...overrides
  });
}
function harness({workerActive=true,leaseActive=true,updateCount=1}={}) {
  const calls=[];let transactions=0;
  const client={async query(sql,values=[]){
    calls.push({sql,values});
    if(sql.includes('FROM worker_nodes'))return{rows:workerActive?[{ok:true}]:[],rowCount:workerActive?1:0};
    if(sql.includes('FROM workflow_leases'))return{rows:leaseActive?[{ok:true}]:[],rowCount:leaseActive?1:0};
    if(sql.startsWith('UPDATE workflows'))return{rows:[],rowCount:updateCount};
    return{rows:[],rowCount:1};
  }};
  const db={
    query(){throw new Error('Fenced workflow writes must use a worker principal transaction');},
    async transactionWithWorkerPrincipal(principal,work){transactions++;assert.equal(principal.kind,'worker');return work(client,principal);}
  };
  return{db,calls,get transactions(){return transactions;}};
}
function workflow(){return{workflowId:'workflow-a',tenantId:'tenant-a',state:'RUNNING',updatedAt:new Date().toISOString(),metadata:{fencingToken:17},toJSON(){return this;}};}

test('workflow state update validates and atomically matches the active worker session and lease',async()=>{
  const h=harness(),repo=new PostgresWorkflowRepository(h.db);
  const result=await repo.save(workflow(),'tenant-a',{workerPrincipal:identity()});
  assert.equal(result.state,'RUNNING');
  assert.equal(h.transactions,1);
  const worker=h.calls.find(x=>x.sql.includes('FROM worker_nodes'));
  const lease=h.calls.find(x=>x.sql.includes('FROM workflow_leases'));
  const update=h.calls.find(x=>x.sql.startsWith('UPDATE workflows'));
  assert.match(worker.sql,/session_id/);
  assert.match(lease.sql,/worker_session_id/);
  assert.match(lease.sql,/fencing_token/);
  assert.match(update.sql,/worker_session_id/);
  assert.deepEqual(update.values.slice(5),['lease-a','worker-a','session-a',17]);
});

test('workflow state update rejects missing, cross-tenant, and cross-workflow principals before SQL',async()=>{
  const h=harness(),repo=new PostgresWorkflowRepository(h.db);
  await assert.rejects(repo.save(workflow(),'tenant-a'),e=>e.code==='WORKER_PERSISTENCE_PRINCIPAL_REQUIRED');
  await assert.rejects(repo.save(workflow(),'tenant-a',{workerPrincipal:identity({tenantId:'tenant-b'})}),e=>e.code==='WORKFLOW_FENCING_REJECTED');
  await assert.rejects(repo.save(workflow(),'tenant-a',{workerPrincipal:identity({workflowId:'workflow-b'})}),e=>e.code==='WORKFLOW_FENCING_REJECTED');
  assert.equal(h.calls.length,0);
});

test('workflow state update rejects a replaced worker session and a stale lease',async()=>{
  const inactive=harness({workerActive:false}),repoA=new PostgresWorkflowRepository(inactive.db);
  await assert.rejects(repoA.save(workflow(),'tenant-a',{workerPrincipal:identity()}),e=>e.code==='WORKER_SESSION_LOST');
  assert.equal(inactive.calls.some(x=>x.sql.includes('FROM workflow_leases')),false);

  const stale=harness({leaseActive:false}),repoB=new PostgresWorkflowRepository(stale.db);
  await assert.rejects(repoB.save(workflow(),'tenant-a',{workerPrincipal:identity()}),e=>e.code==='WORKFLOW_FENCING_REJECTED');
  assert.equal(stale.calls.some(x=>x.sql.startsWith('UPDATE workflows')),false);
});
