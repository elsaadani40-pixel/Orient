'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PostgresWorkflowLeaseRepository}=require('../../../../../src/infrastructure/persistence/postgres/postgres-persistence');
const {createWorkerPersistencePrincipal}=require('../../../../../src/core/security/worker-persistence-principal');
function principal(overrides={}){return createWorkerPersistencePrincipal({tenantId:'tenant-a',workerId:'worker-a',sessionId:'session-a',capabilities:['workflow.execute'],...overrides});}
function harness({sessionId='session-a',insertRows=[{fencing_token:'41'}],updateRows=[{ok:true}]}={}){
 const calls=[];let transactions=0;
 const client={async query(sql,values=[]){calls.push({sql,values});
  if(sql.includes('FROM worker_nodes'))return{rows:[{session_id:sessionId,status:'READY',expires_at:new Date(Date.now()+60000).toISOString()}],rowCount:1};
  if(sql.includes('FROM workflows'))return{rows:[{state:'QUEUED',payload:{}}],rowCount:1};
  if(sql.includes('INSERT INTO workflow_leases'))return{rows:insertRows,rowCount:insertRows.length};
  if(sql.includes('UPDATE workflow_leases')||sql.includes('DELETE FROM workflow_leases'))return{rows:updateRows,rowCount:updateRows.length};
  if(sql.includes('SELECT 1 FROM workflow_leases'))return{rows:updateRows,rowCount:updateRows.length};
  return{rows:[],rowCount:1};}};
 const db={query(){throw new Error('Worker lease operations must use a worker-scoped transaction');},async transactionWithWorkerPrincipal(identity,work){transactions++;assert.equal(identity.kind,'worker');return work(client,identity);}};
 return{db,calls,get transactions(){return transactions;}};
}
test('lease acquisition verifies the registered worker session and persists its session ID',async()=>{
 const h=harness(),repo=new PostgresWorkflowLeaseRepository(h.db),identity=principal();
 const lease=await repo.tryAcquire({workflowId:'workflow-a',leaseId:'lease-a',workerId:'worker-a',acquiredAt:Date.now(),expiresAt:Date.now()+30000,metadata:{tenantId:'tenant-a'}},'tenant-a',{workerPrincipal:identity});
 assert.equal(lease.fencingToken,41);assert.equal(lease.workerSessionId,'session-a');
 const insert=h.calls.find(call=>call.sql.includes('INSERT INTO workflow_leases'));
 assert.match(insert.sql,/worker_session_id/);assert.deepEqual(insert.values.slice(0,5),['workflow-a','tenant-a','lease-a','worker-a','session-a']);assert.equal(h.transactions,1);
});
test('lease acquisition rejects a replaced worker session before insertion',async()=>{
 const h=harness({sessionId:'new-session'}),repo=new PostgresWorkflowLeaseRepository(h.db);
 await assert.rejects(repo.tryAcquire({workflowId:'workflow-a',leaseId:'lease-a',workerId:'worker-a',acquiredAt:Date.now(),expiresAt:Date.now()+30000,metadata:{tenantId:'tenant-a'}},'tenant-a',{workerPrincipal:principal()}),e=>e.code==='WORKER_SESSION_LOST');
 assert.equal(h.calls.some(call=>call.sql.includes('INSERT INTO workflow_leases')),false);
});
test('lease renewal assertion and release require exact session lease and fencing token',async()=>{
 const h=harness(),repo=new PostgresWorkflowLeaseRepository(h.db),bound=principal({workflowId:'workflow-a',leaseId:'lease-a',fencingToken:41});
 assert.equal(await repo.renewIfOwned('workflow-a','lease-a',Date.now()+30000,Date.now(),'tenant-a',{workerPrincipal:bound}),true);
 assert.equal(await repo.assertCurrent('workflow-a','lease-a',41,Date.now(),'tenant-a',{workerPrincipal:bound}),true);
 assert.equal(await repo.delete('workflow-a','lease-a','tenant-a',{workerPrincipal:bound}),true);
 for(const call of h.calls.filter(x=>/UPDATE workflow_leases|SELECT 1 FROM workflow_leases|DELETE FROM workflow_leases/.test(x.sql))){assert.match(call.sql,/worker_session_id/);assert.match(call.sql,/fencing_token/);}
 assert.equal(h.transactions,3);
});
test('lease operations reject principals bound to another workflow before SQL',async()=>{
 const h=harness(),repo=new PostgresWorkflowLeaseRepository(h.db),wrong=principal({workflowId:'workflow-other',leaseId:'lease-a',fencingToken:41});
 await assert.rejects(repo.renewIfOwned('workflow-a','lease-a',Date.now()+30000,Date.now(),'tenant-a',{workerPrincipal:wrong}),e=>e.code==='WORKFLOW_FENCING_REJECTED');
 assert.equal(h.calls.length,0);
});
