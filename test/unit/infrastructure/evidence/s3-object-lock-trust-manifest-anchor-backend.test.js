'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  S3ObjectLockTrustManifestAnchorBackend
} = require('../../../../src/infrastructure/evidence/s3-object-lock-trust-manifest-anchor-backend');

class Command {
  constructor(input) { this.input = input; }
}
const commands = {
  PutObjectCommand: class PutObjectCommand extends Command {},
  GetObjectCommand: class GetObjectCommand extends Command {},
  ListObjectsV2Command: class ListObjectsV2Command extends Command {}
};

class FakeS3 {
  constructor() { this.objects = new Map(); }
  async send(command) {
    const input = command.input;
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
    retentionSeconds: 31536000,
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
  assert.equal(client.lastPut.ObjectLockMode, 'COMPLIANCE');
  assert.equal(client.lastPut.ObjectLockRetainUntilDate.toISOString(), '2027-11-06T12:00:00.000Z');
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
