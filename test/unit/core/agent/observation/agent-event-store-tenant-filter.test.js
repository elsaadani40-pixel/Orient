const test = require('node:test');
const assert = require('node:assert/strict');
const AgentEventStore = require('../../../../src/core/agent/observation/agent-event-store');

test('tenant filtering supports durable memory audit events with top-level tenantId', () => {
  const store = new AgentEventStore();
  const memoryEvent = {
    id: 'memory-event-1',
    type: 'memory.created',
    tenantId: 'tenant-a',
    memoryId: 'memory-1'
  };
  store.append(memoryEvent);
  store.append({
    id: 'agent-event-1',
    type: 'execution.started',
    data: { tenantId: 'tenant-b' }
  });

  assert.deepEqual(store.list({ tenantId: 'tenant-a' }), [memoryEvent]);
  assert.deepEqual(store.list({ tenantId: 'tenant-b' }), [{
    id: 'agent-event-1',
    type: 'execution.started',
    data: { tenantId: 'tenant-b' }
  }]);
  assert.deepEqual(store.list({ tenantId: 'tenant-c' }), []);
});

test('tenant filtering does not expose events with no tenant identity', () => {
  const store = new AgentEventStore();
  store.append({ type: 'execution.started' });

  assert.deepEqual(store.list({ tenantId: 'tenant-a' }), []);
  assert.equal(store.list().length, 1);
});
