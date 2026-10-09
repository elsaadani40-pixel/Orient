'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');

test('pending approval inbox is tenant-scoped, excludes used and expired records, and caps results', async () => {
  const now = Date.parse('2026-10-10T10:00:00.000Z');
  const service = new ApprovalService({
    clock: () => now,
    tenantId: 'tenant-a',
    repository: {
      async findPending({ tenantId, limit, now: queryTime }) {
        assert.equal(tenantId, 'tenant-a');
        assert.equal(limit, 2);
        assert.equal(queryTime, now);
        return [
          { approvalId: 'oldest', executionId: 'exec-1', step: 1, tool: 'tool.a', capability: 'cap.a', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:00:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: false },
          { approvalId: 'expired', executionId: 'exec-2', step: 2, tool: 'tool.b', capability: 'cap.b', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:10:00.000Z', expiresAt: '2026-10-10T09:59:00.000Z', used: false },
          { approvalId: 'foreign', executionId: 'exec-3', step: 3, tool: 'tool.c', capability: 'cap.c', tenantId: 'tenant-b', issuedAt: '2026-10-10T09:20:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: false },
          { approvalId: 'used', executionId: 'exec-4', step: 4, tool: 'tool.d', capability: 'cap.d', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:30:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: true }
        ];
      }
    }
  });

  const pending = await service.listPending({ tenantId: 'tenant-a', limit: 2 });
  assert.deepEqual(pending, [{
    approvalId: 'oldest',
    executionId: 'exec-1',
    step: 1,
    tool: 'tool.a',
    capability: 'cap.a',
    issuedAt: '2026-10-10T09:00:00.000Z',
    expiresAt: '2026-10-10T11:00:00.000Z',
    tenantId: 'tenant-a'
  }]);
  assert.equal(Object.hasOwn(pending[0], 'scope'), false);
  assert.equal(Object.hasOwn(pending[0], 'metadata'), false);
});
