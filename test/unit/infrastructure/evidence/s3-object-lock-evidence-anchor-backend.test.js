'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { S3ObjectLockEvidenceAnchorBackend } = require('../../../../src/infrastructure/evidence/s3-object-lock-evidence-anchor-backend');

class Command {
  constructor(input) { this.input = input; }
}

function commandSet() {
  return {
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    ListObjectsV2Command: class ListObjectsV2Command extends Command {}
  };
}

function notFound() {
  return Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
}

function preconditionFailed() {
  return Object.assign(new Error('already exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
}

class FakeS3 {
  constructor() {
    this.objects = new Map();
    this.putInputs = [];
    this.listCalls = [];
    this.pageSize = 1000;
  }

  async send(command) {
    const input = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      this.putInputs.push(input);
      if (this.objects.has(input.Key)) throw preconditionFailed();
      this.objects.set(input.Key, input.Body);
      return {};
    }
    if (command.constructor.name === 'GetObjectCommand') {
      if (!this.objects.has(input.Key)) throw notFound();
      return { Body: Buffer.from(this.objects.get(input.Key), 'utf8') };
    }
    if (command.constructor.name === 'ListObjectsV2Command') {
      this.listCalls.push(input);
      const keys = [...this.objects.keys()].filter(key => key.startsWith(input.Prefix)).sort();
      const offset = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
      const page = keys.slice(offset, offset + this.pageSize);
      const nextOffset = offset + page.length;
      return {
        Contents: page.map(Key => ({ Key })),
        IsTruncated: nextOffset < keys.length,
        ...(nextOffset < keys.length ? { NextContinuationToken: String(nextOffset) } : {})
      };
    }
    throw new Error('Unexpected S3 command');
  }
}

function fixture(options = {}) {
  const client = new FakeS3();
  const commands = commandSet();
  const backend = new S3ObjectLockEvidenceAnchorBackend({
    client,
    commands,
    bucket: 'orient-evidence-anchors',
    retentionSeconds: 86400,
    now: () => new Date('2026-11-06T12:00:00.000Z'),
    ...options
  });
  return { client, backend, commands };
}

test('S3 Object Lock backend creates anchors conditionally with compliance retention', async () => {
  const { client, backend } = fixture();
  const key = 'orient/evidence-anchors/v1/dGVuYW50/ZXhlY3V0aW9u/0000000000000001';
  const result = await backend.putIfAbsent(key, '{"signed":true}');
  assert.deepEqual(result, { created: true });
  assert.equal(client.putInputs.length, 1);
  assert.equal(client.putInputs[0].IfNoneMatch, '*');
  assert.equal(client.putInputs[0].ObjectLockMode, 'COMPLIANCE');
  assert.equal(client.putInputs[0].ObjectLockRetainUntilDate.toISOString(), '2026-11-07T12:00:00.000Z');
  assert.equal(client.putInputs[0].Bucket, 'orient-evidence-anchors');
});

test('S3 Object Lock backend returns existing bytes on conditional retry', async () => {
  const { backend } = fixture();
  const key = 'orient/evidence-anchors/v1/dGVuYW50/ZXhlY3V0aW9u/0000000000000001';
  await backend.putIfAbsent(key, '{"signed":true}');
  assert.deepEqual(await backend.putIfAbsent(key, '{"signed":true}'), {
    created: false,
    existingValue: '{"signed":true}'
  });
});

test('S3 Object Lock backend reads missing objects as null and rejects unsupported response bodies', async () => {
  const { backend, client, commands } = fixture();
  assert.equal(await backend.get('orient/evidence-anchors/v1/missing'), null);
  client.send = async command => {
    if (command instanceof commands.GetObjectCommand) return { Body: { unsupported: true } };
    throw new Error('unexpected');
  };
  await assert.rejects(
    backend.get('orient/evidence-anchors/v1/object'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_RESPONSE_INVALID'
  );
});

test('S3 Object Lock backend paginates listings and reads object bytes', async () => {
  const { backend, client } = fixture();
  client.pageSize = 1;
  await backend.putIfAbsent('orient/evidence-anchors/v1/a/1', '{"n":1}');
  await backend.putIfAbsent('orient/evidence-anchors/v1/a/2', '{"n":2}');
  const entries = await backend.list('orient/evidence-anchors/v1/a/');
  assert.deepEqual(entries, [
    { key: 'orient/evidence-anchors/v1/a/1', value: '{"n":1}' },
    { key: 'orient/evidence-anchors/v1/a/2', value: '{"n":2}' }
  ]);
  assert.equal(client.listCalls.length, 2);
});

test('S3 Object Lock backend rejects malformed and duplicate listing entries', async () => {
  const { backend, client, commands } = fixture();
  client.send = async command => {
    if (command instanceof commands.ListObjectsV2Command) {
      return { Contents: { Key: 'orient/evidence-anchors/v1/a/1' }, IsTruncated: false };
    }
    throw new Error('unexpected');
  };
  await assert.rejects(
    backend.list('orient/evidence-anchors/v1/a/'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_RESPONSE_INVALID'
  );

  let page = 0;
  client.send = async command => {
    if (command instanceof commands.ListObjectsV2Command) {
      page += 1;
      return {
        Contents: [{ Key: 'orient/evidence-anchors/v1/a/1' }],
        IsTruncated: page === 1,
        ...(page === 1 ? { NextContinuationToken: 'next' } : {})
      };
    }
    throw new Error('unexpected');
  };
  await assert.rejects(
    backend.list('orient/evidence-anchors/v1/a/'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_DUPLICATE_KEY'
  );
});

test('S3 Object Lock backend rejects invalid configuration and unnamespaced keys', async () => {
  const { client } = fixture();
  assert.throws(() => new S3ObjectLockEvidenceAnchorBackend({
    client, commands: commandSet(), bucket: 'bucket', retentionSeconds: 0
  }), /retention period/);
  const { backend } = fixture();
  await assert.rejects(
    backend.get('untrusted/key'),
    error => error.code === 'EVIDENCE_ANCHOR_S3_INPUT_INVALID'
  );
});
