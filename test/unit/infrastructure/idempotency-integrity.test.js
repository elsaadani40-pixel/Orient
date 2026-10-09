const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');const IdempotencyRepository=require('../../../src/infrastructure/persistence/json/idempotency.repository');
function make(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orient-step40-'));return {dir,repo:new IdempotencyRepository(path.join(dir,'idempotency.json'))};}
test('atomic initialization survives concurrent constructors',()=>{const s=make();const workers=Array.from({length:8},()=>new IdempotencyRepository(s.repo.filePath));assert.deepEqual(s.repo.read(),{});for(const w of workers)assert.deepEqual(w.read(),{});fs.rmSync(s.dir,{recursive:true,force:true});});
test('completed idempotency record is immutable and conflicting completion is rejected',()=>{const s=make();const b=s.repo.begin({executionId:'e',step:1,tool:'t',tenantId:'tenant-a'});s.repo.complete(b.key,{ok:true},{tenantId:'tenant-a'});assert.throws(()=>s.repo.complete(b.key,{ok:false},{tenantId:'tenant-a'}),e=>e.code==='IDEMPOTENCY_TERMINAL_CONFLICT');assert.equal(s.repo.findByKey(b.key,{tenantId:'tenant-a'}).result.ok,true);fs.rmSync(s.dir,{recursive:true,force:true});});
test('completed idempotency record cannot transition to failed',()=>{const s=make();const b=s.repo.begin({executionId:'e',step:1,tool:'t',tenantId:'tenant-a'});s.repo.complete(b.key,{ok:true},{tenantId:'tenant-a'});assert.throws(()=>s.repo.fail(b.key,new Error('late failure'),{tenantId:'tenant-a'}),e=>e.code==='IDEMPOTENCY_TERMINAL_CONFLICT');fs.rmSync(s.dir,{recursive:true,force:true});});
test('tenant boundary remains enforced on terminal mutation',()=>{const s=make();const b=s.repo.begin({executionId:'e',step:1,tool:'t',tenantId:'tenant-a'});assert.equal(s.repo.complete(b.key,{ok:true},{tenantId:'tenant-b'}),null);assert.equal(s.repo.findByKey(b.key,{tenantId:'tenant-a'}).status,'running');fs.rmSync(s.dir,{recursive:true,force:true});});
test('tenant-owned idempotency records cannot be read or mutated without the matching tenant identity', () => {
  const s = make();
  const reservation = s.repo.begin({
    executionId: 'tenant-isolation',
    step: 1,
    tool: 'external.write',
    operationId: 'shared-operation-key',
    tenantId: 'tenant-a'
  });

  assert.equal(s.repo.findByKey(reservation.key), null);
  assert.throws(
    () => s.repo.begin({
      executionId: 'tenant-isolation',
      step: 1,
      tool: 'external.write',
      operationId: 'shared-operation-key'
    }),
    error => error.code === 'IDEMPOTENCY_TENANT_MISMATCH'
  );
  assert.equal(s.repo.complete(reservation.key, { ok: true }), null);
  assert.equal(s.repo.fail(reservation.key, new Error('unauthorized mutation')), null);
  assert.equal(s.repo.delete(reservation.key), false);
  assert.equal(s.repo.findByKey(reservation.key, { tenantId: 'tenant-a' }).status, 'running');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('legacy unscoped idempotency records remain recoverable only through local tenant scope', () => {
  const s = make();
  const reservation = s.repo.begin({
    executionId: 'legacy-local',
    step: 1,
    tool: 'external.write',
    operationId: 'legacy-local-operation'
  });

  assert.equal(s.repo.findByKey(reservation.key, { tenantId: 'local' }).status, 'running');
  assert.equal(s.repo.complete(reservation.key, { ok: true }, { tenantId: 'local' }).status, 'completed');
  assert.equal(s.repo.findByKey(reservation.key, { tenantId: 'local' }).result.ok, true);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('terminal updates accept the canonical tenant string used by AgentLoop', () => {
  const s = make();
  const reservation = s.repo.begin({
    executionId: 'canonical-string-tenant',
    step: 1,
    tool: 'external.write',
    tenantId: 'tenant-a'
  });
  assert.equal(s.repo.complete(reservation.key, { ok: true }, 'tenant-a').status, 'completed');
  assert.equal(s.repo.findByKey(reservation.key, 'tenant-a').status, 'completed');
  assert.equal(s.repo.delete(reservation.key, 'tenant-a'), true);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('lock held by a live process is not reclaimed based on directory age', () => {
  const s = make();
  const repo = new IdempotencyRepository(s.repo.filePath, { lockTimeoutMs: 20 });
  fs.mkdirSync(repo.lockPath);
  fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
    token: 'live-owner',
    pid: process.pid,
    hostname: require('os').hostname(),
    acquiredAt: new Date(0).toISOString()
  }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(repo.lockPath, old, old);
  assert.throws(() => repo.withLock(() => true), error => error.code === 'IDEMPOTENCY_STORAGE_LOCK_TIMEOUT');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('lock owned by a dead local process is recovered before acquiring a new lock', () => {
  const s = make();
  const repo = new IdempotencyRepository(s.repo.filePath, { lockTimeoutMs: 100 });
  fs.mkdirSync(repo.lockPath);
  fs.writeFileSync(path.join(repo.lockPath, 'owner.json'), JSON.stringify({
    token: 'dead-owner',
    pid: 2147483647,
    hostname: require('os').hostname(),
    acquiredAt: new Date(0).toISOString()
  }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(repo.lockPath, old, old);
  assert.equal(repo.withLock(() => 'acquired'), 'acquired');
  assert.equal(fs.existsSync(repo.lockPath), false);
  fs.rmSync(s.dir, { recursive: true, force: true });
});
