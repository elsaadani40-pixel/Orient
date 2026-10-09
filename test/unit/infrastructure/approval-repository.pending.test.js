'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ApprovalRepository = require('../../../src/infrastructure/persistence/json/approval.repository');

test('approval repository pending query filters tenant, used, expiry and bounds results', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-approval-pending-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new ApprovalRepository(path.join(directory, 'approvals.json'));
  const now = Date.parse('2026-10-10T10:00:00.000Z');
  const records = [
    { approvalId: 'a1', executionId: 'e1', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:00:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: false },
    { approvalId: 'a2', executionId: 'e2', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:10:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: false },
    { approvalId: 'expired', executionId: 'e3', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:20:00.000Z', expiresAt: '2026-10-10T09:59:00.000Z', used: false },
    { approvalId: 'used', executionId: 'e4', tenantId: 'tenant-a', issuedAt: '2026-10-10T09:30:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: true },
    { approvalId: 'foreign', executionId: 'e5', tenantId: 'tenant-b', issuedAt: '2026-10-10T09:40:00.000Z', expiresAt: '2026-10-10T11:00:00.000Z', used: false }
  ];
  for (const record of records) await repository.save(record, { tenantId: record.tenantId });

  const pending = await repository.findPending({ tenantId: 'tenant-a', limit: 1, now });
  assert.deepEqual(pending.map(record => record.approvalId), ['a1']);
  const allTenantPending = await repository.findPending({ tenantId: 'tenant-a', limit: 100, now });
  assert.deepEqual(allTenantPending.map(record => record.approvalId), ['a1', 'a2']);
});
