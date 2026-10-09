'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');

test('execution event query validates the tenant-scoped execution and bounds replay size', async () => {
  const calls = [];
  const events = Array.from({ length: 250 }, (_, index) => ({
    id: 'event-' + index,
    type: 'execution.step.completed',
    executionId: 'exec-1',
    sequence: index + 1
  }));
  const runtime = {
    tenantId: 'tenant-a',
    persistence: {
      executions: {
        async findById(id, options) {
          calls.push({ kind: 'execution', id, options });
          return { executionId: id };
        }
      },
      events: {
        async findByExecutionId(id, options) {
          calls.push({ kind: 'events', id, options });
          return events;
        }
      }
    }
  };

  const result = await OrientRuntime.prototype.getExecutionEvents.call(runtime, 'exec-1', { limit: 999 });

  assert.equal(result.length, 200);
  assert.equal(result[0].id, 'event-50');
  assert.equal(result.at(-1).id, 'event-249');
  assert.deepEqual(calls, [
    { kind: 'execution', id: 'exec-1', options: { tenantId: 'tenant-a' } },
    { kind: 'events', id: 'exec-1', options: { tenantId: 'tenant-a' } }
  ]);
});

test('execution event query refuses missing or cross-tenant execution before reading events', async () => {
  let eventReads = 0;
  const runtime = {
    tenantId: 'tenant-a',
    persistence: {
      executions: { async findById() { return null; } },
      events: { async findByExecutionId() { eventReads += 1; return []; } }
    }
  };

  await assert.rejects(
    OrientRuntime.prototype.getExecutionEvents.call(runtime, 'other-tenant-execution'),
    error => error.code === 'EXECUTION_NOT_FOUND'
  );
  assert.equal(eventReads, 0);
});

test('execution event query fails closed when durable event storage is absent', async () => {
  const runtime = { tenantId: 'tenant-a', persistence: { executions: { findById() {} } } };
  await assert.rejects(
    OrientRuntime.prototype.getExecutionEvents.call(runtime, 'exec-1'),
    error => error.code === 'EXECUTION_EVENT_STORAGE_REQUIRED'
  );
});
