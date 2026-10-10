'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JsonAccessAuditRepository = require('../../../../src/infrastructure/security/json-access-audit.repository');
const { createAccessAuditEvent } = require('../../../../src/core/security/access-audit-event');

test('JSON audit repository persists ordered records and resumes the hash chain', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-audit-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const repository = new JsonAccessAuditRepository(file);
    const one = createAccessAuditEvent({ requestId: 'one', pathname: '/', method: 'GET', statusCode: 200 });
    const two = createAccessAuditEvent({ requestId: 'two', pathname: '/agent', method: 'POST', statusCode: 202 });
    const first = await repository.record(one);
    const second = await repository.record(two);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].integrity.previousHash, null);
    assert.equal(lines[0].integrity.hash, first.hash);
    assert.equal(lines[1].integrity.previousHash, first.hash);
    assert.equal(lines[1].integrity.hash, second.hash);

    const restarted = new JsonAccessAuditRepository(file);
    const three = createAccessAuditEvent({ requestId: 'three', pathname: '/dashboard', method: 'GET', statusCode: 200 });
    const third = await restarted.record(three);
    const afterRestart = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(afterRestart.length, 3);
    assert.equal(afterRestart[2].integrity.previousHash, second.hash);
    assert.equal(afterRestart[2].integrity.hash, third.hash);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('repository rejects tampered audit records instead of extending a broken chain', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-audit-tamper-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const repository = new JsonAccessAuditRepository(file);
    const event = createAccessAuditEvent({ requestId: 'original', pathname: '/', method: 'GET', statusCode: 200 });
    await repository.record(event);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.sourceIp = '203.0.113.99';
    await fs.writeFile(file, JSON.stringify(record) + '\\n', 'utf8');

    const reopened = new JsonAccessAuditRepository(file);
    await assert.rejects(
      () => reopened.initialize(),
      error => error.code === 'ACCESS_AUDIT_INTEGRITY_FAILED'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
