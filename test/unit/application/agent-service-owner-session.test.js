'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentService = require('../../../src/application/agent/agent.service');

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
  const runtime = {
    tenantId: 'tenant-a',
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
    ownerSessionContext
  });

  assert.strictEqual(forwardedContext, ownerSessionContext);
  assert.equal(result.task.id, 'execution-owner-session');
});
