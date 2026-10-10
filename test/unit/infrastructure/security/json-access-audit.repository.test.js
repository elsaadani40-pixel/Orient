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

test('owner audit view returns bounded newest-first events without integrity internals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-audit-view-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const repository = new JsonAccessAuditRepository(file);
    for (let index = 1; index <= 4; index += 1) {
      await repository.record(createAccessAuditEvent({
        requestId: 'request-' + index,
        pathname: '/agent',
        method: 'POST',
        statusCode: 202
      }));
    }
    const events = await repository.listRecent(2);
    assert.deepEqual(events.map(event => event.requestId), ['request-4', 'request-3']);
    assert.equal(events.some(event => Object.hasOwn(event, 'integrity')), false);
    assert.equal((await repository.listRecent(999)).length, 4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('owner audit view detects tampering after repository initialization', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-audit-view-tamper-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const repository = new JsonAccessAuditRepository(file);
    await repository.record(createAccessAuditEvent({ requestId: 'original', pathname: '/', method: 'GET', statusCode: 200 }));
    await repository.initialize();
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.sourceIp = '203.0.113.88';
    await fs.writeFile(file, JSON.stringify(record) + '\n', 'utf8');
    await assert.rejects(
      () => repository.listRecent(10),
      error => error.code === 'ACCESS_AUDIT_INTEGRITY_FAILED'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit log rotation bounds storage and verifies the retained chain after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-audit-rotation-'));
  const file = path.join(dir, 'events.jsonl');
  const maxFileBytes = 1024;
  const maxArchives = 2;
  try {
    const repository = new JsonAccessAuditRepository(file, { maxFileBytes, maxArchives });
    for (let index = 1; index <= 12; index += 1) {
      await repository.record(createAccessAuditEvent({
        requestId: 'rotation-' + index,
        pathname: '/agent',
        method: 'POST',
        statusCode: 202,
        userAgent: 'u'.repeat(150)
      }));
    }

    const logPaths = [file, file + '.1', file + '.2'];
    let totalBytes = 0;
    for (const logPath of logPaths) {
      try {
        const stats = await fs.stat(logPath);
        assert.ok(stats.size <= maxFileBytes);
        totalBytes += stats.size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    assert.ok(totalBytes <= maxFileBytes * (maxArchives + 1));

    const events = await repository.listRecent(200);
    assert.equal(events[0].requestId, 'rotation-12');
    assert.ok(events.length < 12);
    assert.ok(events.length > 0);

    const reopened = new JsonAccessAuditRepository(file, { maxFileBytes, maxArchives });
    const afterRestart = await reopened.listRecent(200);
    assert.deepEqual(afterRestart.map(event => event.requestId), events.map(event => event.requestId));
    await reopened.record(createAccessAuditEvent({
      requestId: 'rotation-13',
      pathname: '/agent',
      method: 'POST',
      statusCode: 202
    }));
    assert.equal((await reopened.listRecent(1))[0].requestId, 'rotation-13');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit repository rejects an individual event larger than the configured file limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-audit-capacity-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const repository = new JsonAccessAuditRepository(file, { maxFileBytes: 1024, maxArchives: 1 });
    await assert.rejects(
      () => repository.record(createAccessAuditEvent({
        requestId: 'large',
        pathname: '/',
        method: 'GET',
        statusCode: 200,
        userAgent: 'x'.repeat(160)
      })),
      error => error.code === 'ACCESS_AUDIT_EVENT_TOO_LARGE'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
