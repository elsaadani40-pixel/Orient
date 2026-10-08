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
  const claimed=await repo.claimQueued({tenantId:'tenant-a',workerId:'worker-a',limit:10,workerCapabilities:['web.search','calendar.read'],agingQuantumMs:15000});
  assert.equal(claimed.length,1);
  assert.equal(claimed[0].tenantId,'tenant-a');
  const claimCall=calls.find(x=>x.sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.match(claimCall.sql,/FOR UPDATE SKIP LOCKED/);
  assert.match(claimCall.sql,/requiredCapabilities/);
  assert.match(claimCall.sql,/EXTRACT\(EPOCH FROM \(NOW\(\)-w\.updated_at\)\)/);
  assert.deepEqual(claimCall.values.slice(0,5),['tenant-a',10,'worker-a',JSON.stringify(['web.search','calendar.read']),15000]);
  await repo.releaseDispatchClaim('wf-1','worker-a','tenant-a');
  assert.deepEqual(calls.at(-1).values,['tenant-a','wf-1','worker-a']);
});


test('expired dispatch claims are reclaimed by a replacement worker', async () => {
  const calls = [];
  const db = {
    async transaction(work) {
      const client = {
        query: async (sql, values) => {
          calls.push({ sql, values });
          if (sql.includes('SELECT worker_id,capabilities')) return { rows: [{ worker_id: values[1], capabilities: [], status: 'READY', expires_at: new Date(Date.now() + 60000).toISOString() }] };
          if (sql.includes('DELETE FROM workflow_dispatch_claims')) return { rowCount: 1, rows: [] };
          if (sql.includes('INSERT INTO workflow_dispatch_claims')) return { rows: [{ workflow_id: 'wf-recover' }] };
          if (sql.includes('SELECT payload FROM workflows')) return { rows: [{ payload: { workflowId: 'wf-recover', tenantId: 'tenant-a', state: 'QUEUED' } }] };
          return { rowCount: 1, rows: [] };
        }
      };
      return work(client);
    },
    async query(sql, values) { calls.push({ sql, values }); return { rowCount: 0, rows: [] }; }
  };
  const repo = new PostgresWorkflowRepository(db, { register() {} });
  const claimed = await repo.claimQueued({ tenantId: 'tenant-a', workerId: 'worker-new', limit: 1, claimTtlMs: 5000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].workflowId, 'wf-recover');
  const cleanup = calls.find(x => x.sql.includes('DELETE FROM workflow_dispatch_claims'));
  assert.deepEqual(cleanup.values, ['tenant-a']);
});

test('releaseDispatchClaim remains worker-owned', async () => {
  const db = { async query(sql, values) { return { rowCount: sql.includes('worker_id=$3') && values[2] === 'worker-new' ? 0 : 1, rows: [] }; } };
  const repo = new PostgresWorkflowRepository(db);
  assert.equal(await repo.releaseDispatchClaim('wf-recover', 'worker-new', 'tenant-a'), false);
});
