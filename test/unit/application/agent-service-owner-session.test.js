'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentService = require('../../../src/application/agent/agent.service');
const { createPersistencePrincipal } = require('../../../src/core/security/persistence-principal');

test('rejects an inactive owner session before creating an idempotency record', async () => {
  let idempotencyAdmission = false;
  const runtime = {
    tenantId: 'tenant-a',
    persistence: {
      idempotency: {
        begin: async () => {
          idempotencyAdmission = true;
          return { created: true, key: 'idempotency-key' };
        },
        complete: async () => {},
        fail: async () => {}
      }
    },
    assertOwnerSessionContext: async () => {
      throw Object.assign(new Error('inactive owner session'), {
        code: 'OWNER_SESSION_REJECTED'
      });
    }
  };

  const service = new AgentService(runtime);
  await assert.rejects(
    service.createTask({
      goal: 'run a task',
      idempotencyKey: 'owner-session-test-0001',
      ownerSessionContext: { sessionId: 'revoked-session' }
    }),
    error => error.code === 'OWNER_SESSION_REJECTED'
  );

  assert.equal(idempotencyAdmission, false);
});

test('forwards the server-authenticated owner context into runtime execution', async () => {
  let forwardedContext = null;
  const persistencePrincipal = createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    sessionId: 'active-session'
  });
  const runtime = {
    tenantId: 'tenant-a',
    userId: 'owner-a',
    persistence: {
      idempotency: {
        begin: async () => ({ created: true, key: 'idempotency-key' }),
        complete: async () => {},
        fail: async () => {}
      }
    },
    assertOwnerSessionContext: async context => {
      assert.equal(context.sessionId, 'active-session');
      return true;
    },
    execute: async (goal, options) => {
      assert.equal(goal, 'run a task');
      forwardedContext = options.ownerSessionContext;
      return { execution: { executionId: 'execution-owner-session' } };
    },
    getExecutionStatus: async executionId => ({
      executionId,
      status: 'completed'
    })
  };

  const service = new AgentService(runtime);
  const ownerSessionContext = { sessionId: 'active-session' };
  const result = await service.createTask({
    goal: 'run a task',
    idempotencyKey: 'owner-session-test-0002',
    ownerSessionContext,
    persistencePrincipal
  });

  assert.strictEqual(forwardedContext, ownerSessionContext);
  assert.equal(result.task.id, 'execution-owner-session');
});

test('binds task idempotency lifecycle to the same authenticated persistence principal', async () => {
  const persistencePrincipal = createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    sessionId: 'active-session'
  });
  const received = [];
  const runtime = {
    tenantId: 'tenant-a',
    userId: 'owner-a',
    persistence: {
      idempotency: {
        begin: async args => {
          received.push({ method: 'begin', principal: args.persistencePrincipal });
          return { created: true, key: 'principal-bound-key' };
        },
        complete: async (key, result, options) => {
          received.push({ method: 'complete', principal: options.persistencePrincipal });
        },
        fail: async (key, error, options) => {
          received.push({ method: 'fail', principal: options.persistencePrincipal });
        }
      }
    },
    assertOwnerSessionContext: async context => {
      assert.equal(context.sessionId, 'active-session');
      return true;
    },
    execute: async () => ({ execution: { executionId: 'execution-principal-bound' } }),
    getExecutionStatus: async executionId => ({ executionId, status: 'completed' })
  };

  const service = new AgentService(runtime);
  await service.createTask({
    goal: 'run a task',
    idempotencyKey: 'principal-bound-task-key',
    ownerSessionContext: { sessionId: 'active-session' },
    persistencePrincipal
  });

  assert.deepEqual(received.map(item => item.method), ['begin', 'complete']);
  assert.equal(received[0].principal, persistencePrincipal);
  assert.equal(received[1].principal, persistencePrincipal);
});

test('rejects a valid principal issued for a different runtime owner before idempotency admission', async () => {
  let admitted = false;
  const runtime = {
    tenantId: 'tenant-a',
    userId: 'owner-a',
    persistence: {
      idempotency: {
        begin: async () => { admitted = true; return { created: true, key: 'key' }; },
        complete: async () => {},
        fail: async () => {}
      }
    },
    assertOwnerSessionContext: async () => true
  };
  const service = new AgentService(runtime);
  const otherOwnerPrincipal = createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId: 'owner-b',
    sessionId: 'active-session'
  });

  await assert.rejects(
    service.createTask({
      goal: 'run a task',
      idempotencyKey: 'different-owner-principal-key',
      ownerSessionContext: { sessionId: 'active-session' },
      persistencePrincipal: otherOwnerPrincipal
    }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_MISMATCH'
  );
  assert.equal(admitted, false);
});

test('rejects an owner task without a persistence principal before idempotency admission', async () => {
  let admitted = false;
  const runtime = {
    tenantId: 'tenant-a',
    userId: 'owner-a',
    persistence: {
      idempotency: {
        begin: async () => { admitted = true; return { created: true, key: 'key' }; },
        complete: async () => {},
        fail: async () => {}
      }
    },
    assertOwnerSessionContext: async () => true
  };

  await assert.rejects(
    new AgentService(runtime).createTask({
      goal: 'run a task',
      idempotencyKey: 'missing-owner-principal-key',
      ownerSessionContext: { sessionId: 'active-session' }
    }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  assert.equal(admitted, false);
});

test('rejects a forged persistence principal before idempotency admission', async () => {
  let admitted = false;
  const runtime = {
    tenantId: 'tenant-a',
    persistence: {
      idempotency: {
        begin: async () => { admitted = true; return { created: true, key: 'key' }; },
        complete: async () => {},
        fail: async () => {}
      }
    },
    assertOwnerSessionContext: async () => true
  };
  const service = new AgentService(runtime);
  await assert.rejects(
    service.createTask({
      goal: 'run a task',
      idempotencyKey: 'forged-principal-key',
      ownerSessionContext: { sessionId: 'active-session' },
      persistencePrincipal: {
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        sessionId: 'active-session'
      }
    }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  assert.equal(admitted, false);
});


test('rejects legacy owner execution without a persistence principal before runtime execution', async () => {
  let executionStarted = false;
  const runtime = {
    tenantId: 'tenant-a',
    userId: 'owner-a',
    assertOwnerSessionContext: async () => true,
    execute: async () => {
      executionStarted = true;
      return { execution: { executionId: 'should-not-run' } };
    }
  };

  await assert.rejects(
    new AgentService(runtime).execute('run a task', {
      ownerSessionContext: { sessionId: 'active-session' }
    }),
    error => error.code === 'PERSISTENCE_PRINCIPAL_REQUIRED'
  );
  assert.equal(executionStarted, false);
});

test('forwards a validated persistence principal through legacy owner execution', async () => {
  const persistencePrincipal = createPersistencePrincipal({
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    sessionId: 'active-session'
  });
  let forwardedOptions = null;
  const runtime = {
    tenantId: 'tenant-a',
    userId: 'owner-a',
    assertOwnerSessionContext: async context => {
      assert.equal(context.sessionId, 'active-session');
      return true;
    },
    execute: async (goal, options) => {
      assert.equal(goal, 'run a task');
      forwardedOptions = options;
      return { execution: { executionId: 'legacy-principal-bound' } };
    }
  };

  const result = await new AgentService(runtime).execute('run a task', {
    ownerSessionContext: { sessionId: 'active-session' },
    persistencePrincipal
  });

  assert.equal(result.execution.executionId, 'legacy-principal-bound');
  assert.strictEqual(forwardedOptions.persistencePrincipal, persistencePrincipal);
});
