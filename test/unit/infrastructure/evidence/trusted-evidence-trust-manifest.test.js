'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  signTrustManifest,
  verifyTrustManifest,
  verifyAndAcceptTrustManifest,
  MANIFEST_DOMAIN
} = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');

function fixture() {
  const root = crypto.generateKeyPairSync('ed25519');
  const signing = crypto.generateKeyPairSync('ed25519');
  const rootPrivateKey = root.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rootPublicKey = root.publicKey.export({ type: 'spki', format: 'pem' });
  const signingPublicKey = signing.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedRootKeys = { 'offline-root-1': { publicKey: rootPublicKey } };
  const create = (version, overrides = {}) => signTrustManifest({
    version,
    issuedAt: `2026-11-06T10:0${version}:00.000Z`,
    keys: {
      'evidence-key-1': {
        publicKey: signingPublicKey,
        validFrom: '2026-11-06T09:00:00.000Z'
      },
      ...overrides.keys
    },
    ...overrides.payload
  }, { rootKeyId: 'offline-root-1', rootPrivateKey });
  return { create, trustedRootKeys, rootPrivateKey };
}

function memoryVersionStore(initial = null) {
  let state = initial;
  return {
    async read() {
      return state && { ...state };
    },
    async compareAndSet(expected, next) {
      if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
      state = { ...next };
      return true;
    },
    current() {
      return state && { ...state };
    }
  };
}

test('root-signed trust manifest verifies and exposes its trusted evidence keys', () => {
  const f = fixture();
  const manifest = f.create(1);
  const verified = verifyTrustManifest(manifest, f.trustedRootKeys);
  assert.equal(verified.version, 1);
  assert.equal(verified.keys['evidence-key-1'].publicKey.length > 0, true);
  assert.match(verified.digest, /^[a-f0-9]{64}$/);
});

test('trust manifest rejects payload tampering, unknown roots, and noncanonical signatures', () => {
  const f = fixture();
  const manifest = f.create(1);
  assert.equal(verifyTrustManifest({ ...manifest, version: 2 }, f.trustedRootKeys), null);
  assert.equal(verifyTrustManifest(manifest, {}), null);
  assert.equal(verifyTrustManifest({ ...manifest, signature: 'not-base64!' }, f.trustedRootKeys), null);
  assert.equal(verifyTrustManifest({ ...manifest, unexpected: true }, f.trustedRootKeys), null);
});

test('trust manifest requires valid Ed25519 keys and canonical timestamps', () => {
  const f = fixture();
  assert.throws(() => signTrustManifest({
    version: 1,
    issuedAt: 'not-a-date',
    keys: { 'evidence-key-1': { publicKey: 'invalid' } }
  }, { rootKeyId: 'offline-root-1', rootPrivateKey: f.rootPrivateKey }),
  error => error.code === 'EVIDENCE_TRUST_MANIFEST_TIMESTAMP_INVALID');
});

test('monotonic trust store accepts newer versions and rejects rollback', async () => {
  const f = fixture();
  const store = memoryVersionStore();
  const first = f.create(1);
  const second = f.create(2);
  await verifyAndAcceptTrustManifest(first, { trustedRootKeys: f.trustedRootKeys, versionStore: store });
  await verifyAndAcceptTrustManifest(second, { trustedRootKeys: f.trustedRootKeys, versionStore: store });
  assert.equal(store.current().version, 2);
  await assert.rejects(
    verifyAndAcceptTrustManifest(first, { trustedRootKeys: f.trustedRootKeys, versionStore: store }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_ROLLBACK'
  );
});

test('monotonic trust store permits exact retry but rejects same-version content replacement', async () => {
  const f = fixture();
  const store = memoryVersionStore();
  const manifest = f.create(1);
  const accepted = await verifyAndAcceptTrustManifest(manifest, {
    trustedRootKeys: f.trustedRootKeys,
    versionStore: store
  });
  const retry = await verifyAndAcceptTrustManifest(manifest, {
    trustedRootKeys: f.trustedRootKeys,
    versionStore: store
  });
  assert.equal(retry.digest, accepted.digest);

  const other = f.create(1, {
    payload: { issuedAt: '2026-11-06T10:02:00.000Z' }
  });
  await assert.rejects(
    verifyAndAcceptTrustManifest(other, { trustedRootKeys: f.trustedRootKeys, versionStore: store }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_VERSION_CONFLICT'
  );
});

test('monotonic trust store fails closed on missing store and concurrent state change', async () => {
  const f = fixture();
  const manifest = f.create(1);
  await assert.rejects(
    verifyAndAcceptTrustManifest(manifest, { trustedRootKeys: f.trustedRootKeys }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_STORE_REQUIRED'
  );
  const racingStore = {
    async read() { return null; },
    async compareAndSet() { return false; }
  };
  await assert.rejects(
    verifyAndAcceptTrustManifest(manifest, {
      trustedRootKeys: f.trustedRootKeys,
      versionStore: racingStore
    }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_STATE_RACE'
  );
});

test('monotonic trust store rejects malformed persisted state', async () => {
  const f = fixture();
  const store = memoryVersionStore({ version: 0, digest: 'bad' });
  await assert.rejects(
    verifyAndAcceptTrustManifest(f.create(1), {
      trustedRootKeys: f.trustedRootKeys,
      versionStore: store
    }),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_STORE_INVALID'
  );
});

test('trust manifest domain separator uses a terminating NUL byte', () => {
  assert.equal(MANIFEST_DOMAIN, 'ORIENT-TRUSTED-EVIDENCE-MANIFEST-V1\0');
  assert.equal(Buffer.from(MANIFEST_DOMAIN, 'utf8').at(-1), 0);
});


test('trust manifest parsing never invokes accessors or accepts inherited trust roots', () => {
  const f = fixture();
  const valid = f.create(1);
  let getterCalls = 0;
  const unsafeEntry = {};
  Object.defineProperty(unsafeEntry, 'publicKey', {
    enumerable: true,
    get() { getterCalls += 1; return valid.keys['evidence-key-1'].publicKey; }
  });
  const unsafeKeys = { 'evidence-key-1': unsafeEntry };
  const unsafeManifest = { ...valid, keys: unsafeKeys };
  assert.equal(verifyTrustManifest(unsafeManifest, f.trustedRootKeys), null);
  assert.equal(getterCalls, 0);

  let rootGetterCalls = 0;
  const unsafeRoots = {};
  Object.defineProperty(unsafeRoots, 'offline-root-1', {
    enumerable: true,
    get() { rootGetterCalls += 1; return f.trustedRootKeys['offline-root-1']; }
  });
  assert.equal(verifyTrustManifest(valid, unsafeRoots), null);
  assert.equal(rootGetterCalls, 0);

  const inheritedRoots = Object.create({
    'offline-root-1': f.trustedRootKeys['offline-root-1']
  });
  assert.equal(verifyTrustManifest(valid, inheritedRoots), null);
});

test('trust manifest signing rejects symbol and unknown properties', () => {
  const f = fixture();
  const input = {
    version: 1,
    issuedAt: '2026-11-06T10:01:00.000Z',
    keys: { 'evidence-key-1': { publicKey: f.create(1).keys['evidence-key-1'].publicKey } },
    extra: true
  };
  assert.throws(() => signTrustManifest(input, {
    rootKeyId: 'offline-root-1',
    rootPrivateKey: f.rootPrivateKey
  }), error => error.code === 'EVIDENCE_TRUST_MANIFEST_INVALID');

  const symbolInput = { version: 1, issuedAt: '2026-11-06T10:01:00.000Z', keys: input.keys };
  symbolInput[Symbol('hidden')] = true;
  assert.throws(() => signTrustManifest(symbolInput, {
    rootKeyId: 'offline-root-1',
    rootPrivateKey: f.rootPrivateKey
  }), error => error.code === 'EVIDENCE_TRUST_MANIFEST_INVALID');
});
