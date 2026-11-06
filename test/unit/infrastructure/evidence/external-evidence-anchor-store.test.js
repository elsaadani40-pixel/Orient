'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalJson } = require('../../../../src/core/execution/evidence-record');
const { createEvidenceAnchor } = require('../../../../src/infrastructure/evidence/trusted-evidence-cryptography');
const { ExternalEvidenceAnchorStore, anchorKey } = require('../../../../src/infrastructure/evidence/external-evidence-anchor-store');

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedAnchorKeys = { 'owner-anchor-v1': { publicKey } };
  const backend = new MemoryImmutableBackend();
  const store = new ExternalEvidenceAnchorStore({ backend, trustedAnchorKeys });
  const makeAnchor = (sequence, recordHash = sequence.toString(16).padStart(64, '0')) =>
    createEvidenceAnchor({
      tenantId: 'tenant/a',
      executionId: 'execution one',
      sequence,
      recordHash,
      anchoredAt: '2026-11-06T12:00:00.000Z'
    }, { keyId: 'owner-anchor-v1', privateKey });
  return { backend, store, makeAnchor };
}

class MemoryImmutableBackend {
  constructor() { this.objects = new Map(); }
  async putIfAbsent(key, value) {
    if (this.objects.has(key)) return { created: false, existingValue: this.objects.get(key) };
    this.objects.set(key, value);
    return { created: true };
  }
  async get(key) { return this.objects.has(key) ? this.objects.get(key) : null; }
  async list(prefix) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }
}

test('external anchor store persists signed anchors and retrieves them after adapter restart', async () => {
  const { backend, store, makeAnchor } = fixture();
  const anchor = makeAnchor(1);
  assert.deepEqual(await store.append(anchor), { created: true, anchor });

  const restarted = new ExternalEvidenceAnchorStore({
    backend,
    trustedAnchorKeys: { 'owner-anchor-v1': { publicKey: Object.values(store.trustedAnchorKeys)[0].publicKey } }
  });
  assert.deepEqual(await restarted.get({ tenantId: 'tenant/a', executionId: 'execution one', sequence: 1 }), anchor);
});

test('external anchor store makes exact retries idempotent and rejects conflicting immutable sequence', async () => {
  const { store, makeAnchor } = fixture();
  const first = makeAnchor(1);
  assert.equal((await store.append(first)).created, true);
  assert.equal((await store.append(first)).created, false);
  await assert.rejects(
    store.append(makeAnchor(1, 'f'.repeat(64))),
    error => error.code === 'EVIDENCE_ANCHOR_CONFLICT'
  );
});

test('external anchor store lists only verified anchors in sequence order', async () => {
  const { store, makeAnchor } = fixture();
  await store.append(makeAnchor(3));
  await store.append(makeAnchor(1));
  await store.append(makeAnchor(2));
  const anchors = await store.list({ tenantId: 'tenant/a', executionId: 'execution one' });
  assert.deepEqual(anchors.map(anchor => anchor.sequence), [1, 2, 3]);
});

test('external anchor store rejects invalid signatures and tampered stored bytes', async () => {
  const { backend, store, makeAnchor } = fixture();
  const anchor = makeAnchor(1);
  await assert.rejects(
    store.append({ ...anchor, recordHash: 'e'.repeat(64) }),
    error => error.code === 'EVIDENCE_ANCHOR_SIGNATURE_INVALID'
  );
  const key = anchorKey(anchor);
  backend.objects.set(key, canonicalJson({ ...anchor, recordHash: 'e'.repeat(64) }));
  await assert.rejects(
    store.get({ tenantId: anchor.tenantId, executionId: anchor.executionId, sequence: 1 }),
    error => error.code === 'EVIDENCE_ANCHOR_STORE_CORRUPT'
  );
});

test('external anchor store isolates tenant and execution namespaces', async () => {
  const { store, makeAnchor } = fixture();
  const anchor = makeAnchor(1);
  await store.append(anchor);
  assert.equal(await store.get({ tenantId: 'tenant-b', executionId: anchor.executionId, sequence: 1 }), null);
  assert.equal(await store.get({ tenantId: anchor.tenantId, executionId: 'another-execution', sequence: 1 }), null);
});

test('external anchor store fails closed when backend contract is incomplete', async () => {
  assert.throws(
    () => new ExternalEvidenceAnchorStore({ backend: { get() {} }, trustedAnchorKeys: {} }),
    /immutable external anchor backend/
  );
  const { store, makeAnchor } = fixture();
  store.backend.putIfAbsent = async () => ({});
  await assert.rejects(
    store.append(makeAnchor(1)),
    error => error.code === 'EVIDENCE_ANCHOR_STORE_CONTRACT_INVALID'
  );
});
