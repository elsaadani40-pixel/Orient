const test=require('node:test');
const assert=require('node:assert/strict');
const {PostgresWorkflowRepository}=require('../../../../src/infrastructure/persistence/postgres/postgres-persistence');

test('durable workflow dispatch claims are tenant-scoped and worker-owned',async()=>{
  const calls=[];
  const db={
    async transaction(work){
      const client={query:async(sql,values)=>{
        calls.push({sql,values});
        if(sql.includes('RETURNING workflow_id')) return {rows:[{workflow_id:'wf-1'}]};
        if(sql.includes('SELECT payload FROM workflows')) return {rows:[{payload:{workflowId:'wf-1',tenantId:'tenant-a',state:'QUEUED'}}]};
        return {rowCount:1,rows:[]};
      }};
      return work(client);
    },
    async query(sql,values){calls.push({sql,values});return {rowCount:1,rows:[]};}
  };
  const repo=new PostgresWorkflowRepository(db);
  const claimed=await repo.claimQueued({tenantId:'tenant-a',workerId:'worker-a',limit:10});
  assert.equal(claimed.length,1);
  assert.equal(claimed[0].tenantId,'tenant-a');
  assert.match(calls.find(x=>x.sql.includes('FOR UPDATE SKIP LOCKED')).sql,/FOR UPDATE SKIP LOCKED/);
  await repo.releaseDispatchClaim('wf-1','worker-a','tenant-a');
  assert.deepEqual(calls.at(-1).values,['tenant-a','wf-1','worker-a']);
});
