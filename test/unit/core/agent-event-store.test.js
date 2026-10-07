const test = require('node:test');
const assert = require('node:assert/strict');

const AgentEventStore = require('../../../src/core/agent/observation/agent-event-store');

test('event store isolates tenant and event type queries', () => {
  const store = new AgentEventStore();

  store.append({
    id: 'memory-a',
    type: 'memory.created',
    executionId: 'exec-a',
    data: { tenantId: 'tenant-a' }
  });

  store.append({
    id: 'memory-b',
    type: 'memory.created',
    executionId: 'exec-b',
    data: { tenantId: 'tenant-b' }
  });

  store.append({
    id: 'decision-a',
    type: 'decision.created',
    executionId: 'exec-a',
    data: { tenantId: 'tenant-a' }
  });

  assert.equal(store.list({ tenantId: 'tenant-a' }).length, 2);
  assert.equal(store.list({ tenantId: 'tenant-b' }).length, 1);
  assert.equal(store.list({ tenantId: 'tenant-a', type: 'memory.created' }).length, 1);
  assert.equal(store.list({ executionId: 'exec-a', tenantId: 'tenant-b' }).length, 0);
});
