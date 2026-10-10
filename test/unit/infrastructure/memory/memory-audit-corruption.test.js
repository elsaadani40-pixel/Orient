const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MemoryAuditRepository = require('../../../../src/infrastructure/memory/memory-audit.repository');

test('memory audit repository fails closed when its JSON is malformed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-audit-corrupt-json-'));
  const file = path.join(directory, 'audit.json');
  try {
    const repository = new MemoryAuditRepository(file);
    fs.writeFileSync(file, '{"truncated":', 'utf8');
    assert.throws(
      () => repository.read(),
      error => error.code === 'MEMORY_AUDIT_CORRUPT' && /JSON is invalid/.test(error.message)
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('memory audit repository fails closed when its JSON root is not an array', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-audit-invalid-root-'));
  const file = path.join(directory, 'audit.json');
  try {
    const repository = new MemoryAuditRepository(file);
    fs.writeFileSync(file, '{"events":[]}', 'utf8');
    assert.throws(
      () => repository.read(),
      error => error.code === 'MEMORY_AUDIT_CORRUPT' && /root must be an array/.test(error.message)
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('memory audit repository fails closed on an empty existing file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-audit-empty-'));
  const file = path.join(directory, 'audit.json');
  try {
    const repository = new MemoryAuditRepository(file);
    fs.writeFileSync(file, '', 'utf8');
    assert.throws(
      () => repository.read(),
      error => error.code === 'MEMORY_AUDIT_CORRUPT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('memory audit repository round-trips initialized and appended JSON records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-audit-roundtrip-'));
  const file = path.join(directory, 'audit.json');
  try {
    const repository = new MemoryAuditRepository(file);
    assert.deepEqual(repository.read(), []);
    const event = repository.append({
      action: 'memory.created',
      tenantId: 'tenant-a',
      memoryId: 'memory-1'
    });
    const persisted = repository.read();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].action, event.action);
    assert.equal(persisted[0].tenantId, event.tenantId);
    assert.equal(persisted[0].memoryId, event.memoryId);
    assert.ok(persisted[0].occurredAt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
