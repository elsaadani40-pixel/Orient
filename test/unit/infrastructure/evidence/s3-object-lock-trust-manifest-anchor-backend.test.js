'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signTrustManifest } = require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest');
const { ExternalTrustManifestAnchorStore } = require('../../../../src/infrastructure/evidence/external-trust-manifest-anchor-store');
const {
  S3ObjectLockTrustManifestAnchorBackend
} = require('../../../../src/infrastructure/evidence/s3-object-lock-trust-manifest-anchor-backend');

class Command {
  constructor(input) { this.input = input; }
}
const commands = {
  PutObjectCommand: class PutObjectCommand extends Command {},
  GetObjectCommand: class GetObjectCommand extends Command {},
  ListObjectsV2Command: class ListObjectsV2Command extends Command {},
  GetObjectLockConfigurationCommand: class GetObjectLockConfigurationCommand extends Command {},
  GetBucketVersioningCommand: class GetBucketVersioningCommand extends Command {}
};

class FakeS3 {
  constructor() { this.objects = new Map(); }
  async send(command) {
    const input = command.input;
    if (command instanceof commands.GetObjectLockConfigurationCommand) {
      return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 365 } } } };
    }
    if (command instanceof commands.GetBucketVersioningCommand) return { Status: 'Enabled' };
    if (command instanceof commands.PutObjectCommand) {
      if (this.objects.has(input.Key)) {
        throw Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      }
      this.objects.set(input.Key, input.Body);
      this.lastPut = input;
      return {};
    }
    if (command instanceof commands.GetObjectCommand) {
      if (!this.objects.has(input.Key)) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      }
      const body = Buffer.from(this.objects.get(input.Key));
      return { Body: body, ContentLength: body.length };
    }
    if (command instanceof commands.ListObjectsV2Command) {
      const keys = [...this.objects.keys()].filter(key => key.startsWith(input.Prefix)).sort();
      return { Contents: keys.map(Key => ({ Key })), IsTruncated: false };
    }
    throw new Error('Unexpected S3 command');
  }
}

function fixture() {
  const client = new FakeS3();
  const backend = new S3ObjectLockTrustManifestAnchorBackend({
    client,
    commands,
    bucket: 'orient-trust-manifests',
    expectedRetentionDays: 365,
    now: () => new Date('2026-11-06T12:00:00.000Z')
  });
  return { client, backend };
}

test('trust manifest S3 backend writes only to its dedicated namespace with compliance retention', async () => {
  const { client, backend } = fixture();
  const key = 'orient/trust-manifests/v1/0000000000000001.json';
  assert.deepEqual(await backend.putIfAbsent(key, '{"schemaVersion":2}'), { created: true });
  assert.equal(client.lastPut.Bucket, 'orient-trust-manifests');
  assert.equal(client.lastPut.Key, key);
  assert.equal(client.lastPut.IfNoneMatch, '*');
  assert.equal(client.lastPut.ObjectLockMode, undefined);
  assert.equal(client.lastPut.ObjectLockRetainUntilDate, undefined);
  assert.equal(await backend.get(key), '{"schemaVersion":2}');
  assert.deepEqual(await backend.list('orient/trust-manifests/v1/'), [
    { key, value: '{"schemaVersion":2}' }
  ]);
});

test('trust manifest S3 backend rejects evidence and arbitrary namespaces', async () => {
  const { backend } = fixture();
  await assert.rejects(
    backend.putIfAbsent('orient/evidence-anchors/v1/a', '{}'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_INPUT_INVALID'
  );
  await assert.rejects(
    backend.get('untrusted/key'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_INPUT_INVALID'
  );
  await assert.rejects(
    backend.list('orient/evidence-anchors/v1/'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_INPUT_INVALID'
  );
});

test('trust manifest S3 backend makes conditional creation idempotently readable', async () => {
  const { backend } = fixture();
  const key = 'orient/trust-manifests/v1/0000000000000002.json';
  await backend.putIfAbsent(key, '{"version":2}');
  assert.deepEqual(await backend.putIfAbsent(key, '{"version":2}'), {
    created: false,
    existingValue: '{"version":2}'
  });
});


test('S3 Object Lock backend interoperates with the external trust-manifest ledger', async () => {
  const { client, backend } = fixture();
  const root = crypto.generateKeyPairSync('ed25519');
  const evidence = crypto.generateKeyPairSync('ed25519');
  const rootPrivateKey = root.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rootPublicKey = root.publicKey.export({ type: 'spki', format: 'pem' });
  const evidencePublicKey = evidence.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedRootKeys = { 'offline-root-1': { publicKey: rootPublicKey } };
  const store = new ExternalTrustManifestAnchorStore({ backend, trustedRootKeys });
  const manifest = signTrustManifest({
    version: 1,
    issuedAt: '2026-11-06T10:01:00.000Z',
    expiresAt: '2026-12-06T10:01:00.000Z',
    keys: { 'evidence-key-1': { publicKey: evidencePublicKey } }
  }, { rootKeyId: 'offline-root-1', rootPrivateKey });

  const appended = await store.append(manifest, {
    verificationTime: '2026-11-06T10:03:00.000Z'
  });
  assert.equal(appended.created, true);
  assert.deepEqual(await store.readHead(), {
    version: 1,
    digest: require('../../../../src/infrastructure/evidence/trusted-evidence-trust-manifest')
      .verifyTrustManifest(manifest, trustedRootKeys).digest
  });
  assert.equal(client.objects.size, 1);
  assert.equal([...client.objects.keys()][0], 'orient/trust-manifests/v1/0000000000000001.json');
});


test('trust manifest S3 backend verifies versioning and exact default compliance retention before IO', async () => {
  const { backend, client } = fixture();
  assert.deepEqual(await backend.verifyConfiguration(), {
    objectLockEnabled: true,
    versioningEnabled: true,
    retentionMode: 'COMPLIANCE',
    retentionDays: 365
  });
  assert.deepEqual(await backend.verifyConfiguration(), {
    objectLockEnabled: true,
    versioningEnabled: true,
    retentionMode: 'COMPLIANCE',
    retentionDays: 365
  });

  const invalid = new FakeS3();
  invalid.send = async command => {
    if (command instanceof commands.GetObjectLockConfigurationCommand) {
      return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 365 } } } };
    }
    if (command instanceof commands.GetBucketVersioningCommand) return { Status: 'Enabled' };
    throw new Error('trust IO must not proceed with invalid bucket configuration');
  };
  const unsafeBackend = new S3ObjectLockTrustManifestAnchorBackend({
    client: invalid,
    commands,
    bucket: 'orient-trust-manifests',
    expectedRetentionDays: 365
  });
  await assert.rejects(
    unsafeBackend.putIfAbsent('orient/trust-manifests/v1/0000000000000001.json', '{}'),
    error => error.code === 'EVIDENCE_TRUST_MANIFEST_S3_CONFIGURATION_INVALID'
  );
  assert.equal(client.objects.size, 0);
});

test('trust manifest S3 backend requires an explicit expected retention policy', () => {
  const client = new FakeS3();
  assert.throws(() => new S3ObjectLockTrustManifestAnchorBackend({
    client,
    commands,
    bucket: 'orient-trust-manifests'
  }), /expected bucket COMPLIANCE retention/);
});
