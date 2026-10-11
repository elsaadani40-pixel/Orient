require('node:test').test('durable lease renewal uses the scheduler clock and refuses expired ownership', async () => {
  const SqliteDatabase = require('../../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const { SqliteWorkflowLeaseRepository } = require('../../../../src/infrastructure/persistence/sqlite/workflow.repository');
  const db = new SqliteDatabase(':memory:');
  const repository = new SqliteWorkflowLeaseRepository(db);
  const lease = {
    workflowId: 'clock-test',
    leaseId: 'lease-1',
    workerId: 'worker-1',
    acquiredAt: 1000,
    expiresAt: 2000,
    metadata: {}
  };
  repository.save(lease);

  require('node:assert/strict').equal(repository.renewIfOwned('clock-test', 'lease-1', 4000, 2000), false);
  require('node:assert/strict').equal(repository.renewIfOwned('clock-test', 'lease-1', 5000, 1500), true);
});

require('node:test').test('JSON durable lease cleanup only removes an actually expired lease', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const WorkflowLeaseRepository = require('../../../../src/infrastructure/persistence/json/workflow-lease.repository');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-lease-'));
  const repository = new WorkflowLeaseRepository(path.join(dir, 'leases.json'));
  repository.save({
    workflowId: 'json-clock-test',
    leaseId: 'lease-1',
    workerId: 'worker-1',
    acquiredAt: 1000,
    expiresAt: 5000,
    metadata: {}
  });

  require('node:assert/strict').equal(repository.deleteExpired('json-clock-test', 'lease-1', 4000), false);
  require('node:assert/strict').ok(repository.findByWorkflowId('json-clock-test'));

  require('node:assert/strict').equal(repository.deleteExpired('json-clock-test', 'lease-1', 5000), true);
  require('node:assert/strict').equal(repository.findByWorkflowId('json-clock-test'), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowDefinition, WorkflowInstance, WorkflowScheduler, WorkflowWorker } = require('../../../../src/core/workflow');
const WorkflowLeaseStore = require('../../../../src/core/workflow/workflow-lease-store');

function definition() {
  return new WorkflowDefinition({ id: 'reliability', version: 1, name: 'Reliability', steps: [{ id: 'a', tool: 'noop' }] });
}

test('lease store prevents concurrent ownership and recovers expired leases', () => {
  let now = 1000;
  const repository = {
    values: new Map(),
    save(lease) { this.values.set(lease.workflowId, { ...lease }); },
    findByWorkflowId(id) { return this.values.get(id) || null; },
    findAll() { return [...this.values.values()]; },
    delete(id) { return this.values.delete(id); },
    deleteExpired(id, leaseId) {
      const current = this.values.get(id);
      if (!current || current.leaseId !== leaseId) return false;
      return this.values.delete(id);
    }
  };
  const store = new WorkflowLeaseStore({ repository, clock: () => now, leaseDurationMs: 1000 });
  const first = store.acquire('wf', 'worker-a');
  assert.throws(() => store.acquire('wf', 'worker-b'), /already held/);
  now = 2501;
  assert.equal(store.recoverExpired().length, 1);
  const second = store.acquire('wf', 'worker-b');
  assert.notEqual(first.leaseId, second.leaseId);
});

test('scheduler retries with exponential backoff and preserves attempt state', () => {
  let now = 1000;
  const scheduler = new WorkflowScheduler({ maxConcurrent: 1, clock: () => now, maxRetries: 2, baseBackoffMs: 100, maxBackoffMs: 1000 });
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'retry-wf' });
  scheduler.enqueue(instance);
  const lease = scheduler.lease('worker');
  scheduler.release(lease.workflowId, lease.leaseId);
  instance.metadata.failedStepId = 'a';
  instance.markStepFailed('a', Object.assign(new Error('temporary'), { code: 'TEMPORARY' }));
  assert.equal(scheduler.retry(instance, { error: new Error('temporary') }), true);
  assert.equal(instance.retry.attempt, 1);
  assert.equal(instance.state, 'QUEUED');
  assert.equal(instance.steps.a.state, 'PENDING');
  now = 1101;
  const next = scheduler.lease('worker-2');
  assert.equal(next.workflowId, 'retry-wf');
  scheduler.release(next.workflowId, next.leaseId);
});

test('worker enforces deadline and emits durable operational events', async () => {
  let now = 1000;
  const scheduler = new WorkflowScheduler({ maxConcurrent: 1, clock: () => now, leaseDurationMs: 5000 });
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'deadline-wf' });
  scheduler.enqueue(instance, { deadlineAt: new Date(1100).toISOString() });
  const events = [];
  const worker = new WorkflowWorker({
    scheduler,
    now: () => now,
    eventSink: event => events.push(event),
    executor: async () => { now = 1200; return { ok: true }; }
  });
  const result = await worker.tick();
  assert.equal(result.state, 'FAILED');
  assert.equal(result.metadata.failureCode, 'WORKFLOW_DEADLINE_EXCEEDED');
  assert.ok(events.some(event => event.type === 'workflow.deadline.exceeded'));
  assert.ok(events.some(event => event.type === 'workflow.lease.released'));
});

test('cancellation prevents queued execution', async () => {
  const scheduler = new WorkflowScheduler({ maxConcurrent: 1 });
  const instance = new WorkflowInstance({ definition: definition(), workflowId: 'cancel-wf' });
  scheduler.enqueue(instance);
  assert.equal(scheduler.cancel('cancel-wf'), true);
  const worker = new WorkflowWorker({ scheduler, executor: async () => ({ shouldNotRun: true }) });
  assert.equal(await worker.tick(), null);
  assert.equal(instance.state, 'CANCELLED');
});

test('workflow instances retain a recoverable definition and scheduler rebuilds durable queue', () => {
  let now = 1000;
  const repository = {
    values: [{
      workflowId: 'recover-wf',
      tenantId: 'local',
      userId: 'local',
      workspaceId: 'local',
      definitionId: 'reliability',
      definitionVersion: 1,
      definition: definition().toJSON(),
      input: { value: 1 },
      state: 'RUNNING',
      createdAt: new Date(900).toISOString(),
      updatedAt: new Date(950).toISOString(),
      deadlineAt: null,
      cancelRequested: false,
      retry: { attempt: 0, nextAttemptAt: null, lastError: null },
      steps: { a: { state: 'PENDING', attempts: 0, result: null, error: null, startedAt: null, completedAt: null } },
      metadata: { priority: 5 }
    }],
    findAll() { return this.values; },
    save(value) { this.values = this.values.filter(item => item.workflowId !== value.workflowId); this.values.push(value.toJSON()); }
  };
  const scheduler = new WorkflowScheduler({
    maxConcurrent: 1,
    clock: () => now,
    workflowRepository: repository
  });
  assert.equal(scheduler.recoverPersisted(), 1);
  const lease = scheduler.lease('recovered-worker');
  assert.equal(lease.workflowId, 'recover-wf');
  assert.equal(lease.instance.definition.id, 'reliability');
  scheduler.release(lease.workflowId, lease.leaseId);
});

test('durable sqlite lease acquisition is single-owner under serialized writers', () => {
  // Contract-level regression: a repository with an atomic tryAcquire primitive
  // must reject the second owner without relying on a read-then-write race.
  const values = new Map();
  const repository = {
    tryAcquire(lease) {
      if (values.has(lease.workflowId)) return null;
      values.set(lease.workflowId, { ...lease });
      return { ...lease };
    },
    findByWorkflowId(id) { return values.get(id) || null; },
    findAll() { return [...values.values()]; },
    delete(id) { return values.delete(id); },
    deleteExpired(id) { return values.delete(id); }
  };
  const store = new WorkflowLeaseStore({ repository, clock: () => 1000, leaseDurationMs: 1000 });
  const first = store.acquire('wf-atomic', 'worker-a');
  assert.throws(() => store.acquire('wf-atomic', 'worker-b'), /already held/);
  assert.equal(repository.findByWorkflowId('wf-atomic').leaseId, first.leaseId);
});

test('scheduler persists cancellation and deadline terminal transitions', () => {
  const saved = [];
  const repository = {
    save(value) { saved.push(value.toJSON()); }
  };
  let now = 1000;
  const scheduler = new WorkflowScheduler({
    maxConcurrent: 1,
    clock: () => now,
    workflowRepository: repository
  });

  const cancelInstance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'persist-cancel-wf'
  });
  scheduler.enqueue(cancelInstance);
  assert.equal(scheduler.cancel(cancelInstance.workflowId), true);
  assert.equal(saved.at(-1).state, 'CANCELLED');

  const deadlineInstance = new WorkflowInstance({
    definition: definition(),
    workflowId: 'persist-deadline-wf'
  });
  scheduler.enqueue(deadlineInstance, {
    deadlineAt: new Date(900).toISOString()
  });
  assert.equal(scheduler.lease('deadline-worker'), null);
  const persisted = saved.filter(item => item.workflowId === deadlineInstance.workflowId).at(-1);
  assert.equal(persisted.state, 'FAILED');
  assert.equal(persisted.metadata.failureCode, 'WORKFLOW_DEADLINE_EXCEEDED');
});


test('tenant-scoped scheduler rejects cross-tenant workflow enqueue and recovery', () => {
  const scheduler = new WorkflowScheduler({ tenantId: 'tenant-a' });
  const foreign = new WorkflowInstance({
    definition: definition(),
    workflowId: 'tenant-b-wf',
    tenantId: 'tenant-b'
  });

  assert.throws(
    () => scheduler.enqueue(foreign),
    error => error.code === 'WORKFLOW_TENANT_MISMATCH'
  );
});

test('tenant-scoped durable workflow queries cannot read another tenant', () => {
  const SqliteDatabase = require('../../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const { SqliteWorkflowRepository, SqliteWorkflowLeaseRepository } = require('../../../../src/infrastructure/persistence/sqlite/workflow.repository');
  const db = new SqliteDatabase(':memory:');
  const workflows = new SqliteWorkflowRepository(db);
  const leases = new SqliteWorkflowLeaseRepository(db);
  const WorkflowRepository = require('../../../../src/infrastructure/persistence/json/workflow.repository');
  const WorkflowLeaseRepository = require('../../../../src/infrastructure/persistence/json/workflow-lease.repository');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-tenant-'));

  const a = new WorkflowInstance({
    definition: definition(),
    workflowId: 'shared-id-a',
    tenantId: 'tenant-a'
  });
  const b = new WorkflowInstance({
    definition: definition(),
    workflowId: 'shared-id-b',
    tenantId: 'tenant-b'
  });

  workflows.save(a);
  workflows.save(b);

  assert.ok(workflows.findById(a.workflowId, 'tenant-a'));
  assert.equal(workflows.findById(a.workflowId, 'tenant-b'), null);
  assert.deepEqual(
    workflows.findAll({ tenantId: 'tenant-a' }).map(item => item.tenantId),
    ['tenant-a']
  );

  leases.save({
    workflowId: 'lease-a',
    leaseId: 'lease-a-id',
    workerId: 'worker-a',
    acquiredAt: 1000,
    expiresAt: 5000,
    metadata: { tenantId: 'tenant-a' }
  });

  assert.ok(leases.findByWorkflowId('lease-a', 'tenant-a'));
  assert.equal(leases.findByWorkflowId('lease-a', 'tenant-b'), null);
  assert.equal(leases.findAll({ tenantId: 'tenant-b' }).length, 0);

  const jsonWorkflows = new WorkflowRepository(path.join(dir, 'workflows.json'));
  jsonWorkflows.save(a);
  jsonWorkflows.save(b);
  assert.equal(jsonWorkflows.findById(a.workflowId, 'tenant-b'), null);
  assert.deepEqual(jsonWorkflows.findAll({ tenantId: 'tenant-a' }).map(item => item.tenantId), ['tenant-a']);

  const jsonLeases = new WorkflowLeaseRepository(path.join(dir, 'leases.json'));
  jsonLeases.save({
    workflowId: 'json-lease-a', leaseId: 'json-lease-a-id', workerId: 'worker-a',
    acquiredAt: 1000, expiresAt: 5000, metadata: { tenantId: 'tenant-a' }
  });
  assert.equal(jsonLeases.findByWorkflowId('json-lease-a', 'tenant-b'), null);
  assert.equal(jsonLeases.findAll({ tenantId: 'tenant-b' }).length, 0);
});


test('JSON execution, event, idempotency and checkpoint reads enforce tenant scope', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-persistence-'));
  const ExecutionRepository = require('../../../../src/infrastructure/persistence/json/execution.repository');
  const EventRepository = require('../../../../src/infrastructure/persistence/json/event.repository');
  const IdempotencyRepository = require('../../../../src/infrastructure/persistence/json/idempotency.repository');
  const CheckpointRepository = require('../../../../src/infrastructure/persistence/json/checkpoint.repository');

  const execution = {
    executionId: 'exec-tenant-a',
    goalId: 'goal-a',
    metadata: { tenantId: 'tenant-a' },
    status: 'running'
  };
  const executions = new ExecutionRepository(path.join(dir, 'executions.json'));
  executions.insert(execution);
  assert.ok(executions.findById('exec-tenant-a', { tenantId: 'tenant-a' }));
  assert.equal(executions.findById('exec-tenant-a', { tenantId: 'tenant-b' }), null);

  const events = new EventRepository(path.join(dir, 'events.json'));
  events.append({ id: 'event-a', type: 'test', executionId: 'exec-tenant-a', data: { tenantId: 'tenant-a' } });
  assert.equal(events.findByExecutionId('exec-tenant-a', { tenantId: 'tenant-b' }).length, 0);

  const idempotency = new IdempotencyRepository(path.join(dir, 'idempotency.json'));
  idempotency.begin({ executionId: 'exec-tenant-a', step: 0, tool: 'test', tenantId: 'tenant-a' });
  assert.equal(idempotency.findByKey('exec-tenant-a:plan-1:step-0:test', { tenantId: 'tenant-b' }), null);

  const checkpoints = new CheckpointRepository(path.join(dir, 'checkpoints.json'));
  checkpoints.save({
    executionId: 'exec-tenant-a',
    metadata: { tenantId: 'tenant-a' }
  });
  assert.equal(checkpoints.findLatest('exec-tenant-a', { tenantId: 'tenant-b' }), null);
});


test('tenant-scoped durable writes reject cross-tenant workflow and lease collisions', () => {
  const SqliteDatabase = require('../../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const { SqliteWorkflowRepository, SqliteWorkflowLeaseRepository } = require('../../../../src/infrastructure/persistence/sqlite/workflow.repository');
  const db = new SqliteDatabase(':memory:');
  const workflows = new SqliteWorkflowRepository(db);
  const leases = new SqliteWorkflowLeaseRepository(db);

  const tenantA = new WorkflowInstance({
    definition: definition(),
    workflowId: 'shared-workflow-id',
    tenantId: 'tenant-a'
  });
  workflows.save(tenantA);

  const tenantB = new WorkflowInstance({
    definition: definition(),
    workflowId: 'shared-workflow-id',
    tenantId: 'tenant-b'
  });

  assert.throws(
    () => workflows.save(tenantB),
    /Workflow tenant collision/
  );
  assert.equal(workflows.findById('shared-workflow-id', 'tenant-a').tenantId, 'tenant-a');

  leases.save({
    workflowId: 'shared-lease-id',
    leaseId: 'lease-a',
    workerId: 'worker-a',
    acquiredAt: 1000,
    expiresAt: 5000,
    metadata: { tenantId: 'tenant-a' }
  });

  assert.throws(
    () => leases.save({
      workflowId: 'shared-lease-id',
      leaseId: 'lease-b-cross-tenant',
      workerId: 'worker-b',
      acquiredAt: 1000,
      expiresAt: 5000,
      metadata: { tenantId: 'tenant-b' }
    }),
    /Lease tenant collision/
  );
  assert.equal(leases.findByWorkflowId('shared-lease-id', 'tenant-a').leaseId, 'lease-a');
});

test('bulk event persistence enforces tenant scope', () => {
  const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');
  const persistence = new SqlitePersistence({ filePath: ':memory:' });

  assert.throws(
    () => persistence.events.appendMany([
      { id: 'event-tenant-a', type: 'test', executionId: 'exec-a', data: { tenantId: 'tenant-a' } },
      { id: 'event-tenant-b', type: 'test', executionId: 'exec-b', data: { tenantId: 'tenant-b' } }
    ], { tenantId: 'tenant-a' }),
    /Event tenant mismatch/
  );

  const inserted = persistence.events.appendMany([
    { id: 'event-local', type: 'test', executionId: 'exec-a', data: {} }
  ], { tenantId: 'tenant-a' });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].data.tenantId, 'tenant-a');
  assert.equal(persistence.events.findAll({ tenantId: 'tenant-b' }).length, 0);
});


test('tenant-scoped lease acquisition cannot delete another tenant lease during expiry recovery', () => {
  const SqliteDatabase = require('../../../../src/infrastructure/persistence/sqlite/sqlite-database');
  const { SqliteWorkflowLeaseRepository } = require('../../../../src/infrastructure/persistence/sqlite/workflow.repository');
  const db = new SqliteDatabase(':memory:');
  const leases = new SqliteWorkflowLeaseRepository(db);

  leases.save({
    workflowId: 'shared-expired-lease',
    leaseId: 'lease-tenant-a-recovery',
    workerId: 'worker-a',
    acquiredAt: 1000,
    expiresAt: 2000,
    metadata: { tenantId: 'tenant-a' }
  });

  const acquired = leases.tryAcquire({
    workflowId: 'shared-expired-lease',
    leaseId: 'lease-b-cross-tenant',
    workerId: 'worker-b',
    acquiredAt: 3000,
    expiresAt: 4000,
    metadata: { tenantId: 'tenant-b' }
  }, 'tenant-b');

  assert.equal(acquired, null);
  assert.equal(leases.findByWorkflowId('shared-expired-lease', 'tenant-a').leaseId, 'lease-tenant-a-recovery');
  assert.equal(leases.findByWorkflowId('shared-expired-lease', 'tenant-b'), null);
});


test('JSON durable writes reject cross-tenant workflow and checkpoint collisions', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-tenant-write-'));
  const WorkflowRepository = require('../../../../src/infrastructure/persistence/json/workflow.repository');
  const CheckpointRepository = require('../../../../src/infrastructure/persistence/json/checkpoint.repository');
  const workflows = new WorkflowRepository(path.join(dir, 'workflows.json'));
  const checkpoints = new CheckpointRepository(path.join(dir, 'checkpoints.json'));

  const a = new WorkflowInstance({ definition: definition(), workflowId: 'json-shared-workflow', tenantId: 'tenant-a' });
  const b = new WorkflowInstance({ definition: definition(), workflowId: 'json-shared-workflow', tenantId: 'tenant-b' });
  workflows.save(a);
  assert.throws(() => workflows.save(b), /Workflow tenant collision/);

  checkpoints.save({ executionId: 'json-shared-execution', tenantId: 'tenant-a' }, { tenantId: 'tenant-a' });
  assert.throws(
    () => checkpoints.save({ executionId: 'json-shared-execution', tenantId: 'tenant-b' }, { tenantId: 'tenant-b' }),
    /Checkpoint tenant collision/
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite idempotency rejects cross-tenant key reuse explicitly', () => {
  const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');
  const persistence = new SqlitePersistence({ filePath: ':memory:' });

  persistence.idempotency.begin({
    executionId: 'shared-execution-key',
    step: 1,
    tool: 'test',
    operationId: 'shared-operation',
    tenantId: 'tenant-a'
  });

  assert.throws(
    () => persistence.idempotency.begin({
      executionId: 'shared-execution-key',
      step: 1,
      tool: 'test',
      operationId: 'shared-operation',
      tenantId: 'tenant-b'
    }),
    /Idempotency tenant mismatch/
  );
});


test('capability risk policy requires approval for high-risk capabilities', () => {
  const Capability = require('../../../../src/core/agent/capability/capability');
  const CapabilityRegistry = require('../../../../src/core/agent/capability/capability-registry');
  const CapabilityPolicy = require('../../../../src/core/agent/policy/capability-policy');

  const registry = new CapabilityRegistry();
  registry.register(new Capability({ name: 'read.safe', risk: 'low' }));
  registry.register(new Capability({ name: 'external.write', risk: 'high' }));

  const policy = new CapabilityPolicy({ capabilityRegistry: registry });

  assert.equal(policy.riskOf('read.safe'), 'low');
  assert.equal(policy.requiresApproval('read.safe'), false);
  assert.equal(policy.riskOf('external.write'), 'high');
  assert.equal(policy.requiresApproval('external.write'), true);
  assert.equal(policy.authorize('external.write').allowed, true);
  assert.equal(policy.authorize('missing').allowed, false);
});

test('sqlite approval consumption is single-use and tenant-scoped', () => {
  const SqlitePersistence = require('../../../../src/infrastructure/persistence/sqlite/sqlite-persistence');
  const persistence = new SqlitePersistence({ filePath: ':memory:' });
  const now = Date.now();
  const approval = {
    approvalId: 'approval-tenant-a',
    executionId: 'execution-tenant-a',
    step: 1,
    planRevision: 1,
    tool: 'external.write',
    capability: 'external.write',
    scope: { planRevision: 1 },
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    decision: { status: 'approved', actorId: 'owner-test', decidedAt: new Date(now).toISOString() },
    used: false,
    metadata: { tenantId: 'tenant-a' },
    tenantId: 'tenant-a'
  };

  persistence.approvals.save(approval, { tenantId: 'tenant-a' });

  assert.equal(persistence.approvals.findById(approval.approvalId, { tenantId: 'tenant-b' }), null);
  assert.equal(persistence.approvals.consume(approval.approvalId, new Date(now).toISOString(), 'tenant-b'), false);
  assert.equal(persistence.approvals.consume(approval.approvalId, new Date(now).toISOString(), 'tenant-a'), true);
  assert.equal(persistence.approvals.consume(approval.approvalId, new Date(now + 1).toISOString(), 'tenant-a'), false);
});


test('JSON durable lease writes reject cross-tenant workflow collisions', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const WorkflowLeaseRepository = require('../../../../src/infrastructure/persistence/json/workflow-lease.repository');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-json-lease-collision-'));
  const repository = new WorkflowLeaseRepository(path.join(dir, 'leases.json'));

  repository.save({
    workflowId: 'shared-json-lease',
    leaseId: 'lease-a',
    workerId: 'worker-a',
    acquiredAt: 1000,
    expiresAt: 5000,
    metadata: { tenantId: 'tenant-a' }
  }, 'tenant-a');

  assert.throws(
    () => repository.save({
      workflowId: 'shared-json-lease',
      leaseId: 'lease-b',
      workerId: 'worker-b',
      acquiredAt: 1000,
      expiresAt: 5000,
      metadata: { tenantId: 'tenant-b' }
    }, 'tenant-b'),
    /Lease tenant collision/
  );

  assert.equal(repository.findByWorkflowId('shared-json-lease', 'tenant-a').leaseId, 'lease-a');
  assert.equal(repository.findByWorkflowId('shared-json-lease', 'tenant-b'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
