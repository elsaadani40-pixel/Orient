'use strict';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isNotFound(error) {
  return error?.name === 'NoSuchKey' ||
    error?.name === 'NotFound' ||
    error?.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(error) {
  return error?.name === 'PreconditionFailed' ||
    error?.$metadata?.httpStatusCode === 412;
}

function isConditionalConflict(error) {
  return error?.name === 'ConditionalRequestConflict' ||
    error?.$metadata?.httpStatusCode === 409;
}

async function bodyToUtf8(body) {
  if (body && typeof body.transformToString === 'function') {
    return body.transformToString('utf-8');
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) return String(body);
  fail('EVIDENCE_ANCHOR_S3_RESPONSE_INVALID', 'S3 GetObject returned an unsupported body type');
}

/**
 * AWS S3 Object Lock backend for ExternalEvidenceAnchorStore.
 *
 * The caller supplies AWS SDK v3 command constructors to keep the core package
 * free of a mandatory cloud SDK dependency. The bucket must have Object Lock
 * enabled, versioning enabled, and a policy that denies deletion and bypass
 * retention for the adapter principal. Compliance retention is applied on
 * creation; this adapter never issues overwrite or delete requests.
 */
class S3ObjectLockEvidenceAnchorBackend {
  constructor({
    client,
    commands,
    bucket,
    retentionSeconds,
    now = () => new Date(),
    maxConditionalRetries = 3,
    retryDelayMs = 25,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    maxConcurrentReads = 8
  } = {}) {
    if (!client || typeof client.send !== 'function') {
      throw new TypeError('An AWS S3 SDK v3 client is required');
    }
    const requiredCommands = ['PutObjectCommand', 'GetObjectCommand', 'ListObjectsV2Command'];
    if (!commands || requiredCommands.some(name => typeof commands[name] !== 'function')) {
      throw new TypeError('S3 PutObject, GetObject, and ListObjectsV2 command constructors are required');
    }
    if (typeof bucket !== 'string' || !bucket.trim()) {
      throw new TypeError('A dedicated S3 bucket is required');
    }
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1) {
      throw new TypeError('A positive S3 Object Lock retention period in seconds is required');
    }
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    if (!Number.isSafeInteger(maxConditionalRetries) || maxConditionalRetries < 0) {
      throw new TypeError('A non-negative maximum conditional retry count is required');
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError('A non-negative conditional retry delay is required');
    }
    if (typeof sleep !== 'function') throw new TypeError('A retry sleep function is required');
    if (!Number.isSafeInteger(maxConcurrentReads) || maxConcurrentReads < 1) {
      throw new TypeError('A positive maximum concurrent read count is required');
    }

    this.client = client;
    this.commands = commands;
    this.bucket = bucket;
    this.retentionSeconds = retentionSeconds;
    this.now = now;
    this.maxConditionalRetries = maxConditionalRetries;
    this.retryDelayMs = retryDelayMs;
    this.sleep = sleep;
    this.maxConcurrentReads = maxConcurrentReads;
  }

  async putIfAbsent(key, value) {
    if (typeof key !== 'string' || !key.startsWith('orient/evidence-anchors/v1/') ||
        typeof value !== 'string') {
      fail('EVIDENCE_ANCHOR_S3_INPUT_INVALID', 'A namespaced anchor key and canonical string value are required');
    }
    const now = this.now();
    const retainUntil = new Date(now.getTime() + this.retentionSeconds * 1000);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(retainUntil.getTime())) {
      fail('EVIDENCE_ANCHOR_S3_CLOCK_INVALID', 'Unable to calculate an S3 retention deadline');
    }

    const input = {
      Bucket: this.bucket,
      Key: key,
      Body: value,
      ContentType: 'application/json',
      IfNoneMatch: '*',
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil
    };

    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.send(new this.commands.PutObjectCommand(input));
        return { created: true };
      } catch (error) {
        if (isPreconditionFailed(error)) {
          const existingValue = await this.get(key);
          if (existingValue === null) {
            fail('EVIDENCE_ANCHOR_S3_CONDITIONAL_RACE', 'S3 rejected conditional creation but the existing object is not readable');
          }
          return { created: false, existingValue };
        }
        if (!isConditionalConflict(error) || attempt >= this.maxConditionalRetries) {
          throw error;
        }
        const delay = this.retryDelayMs * (attempt + 1);
        if (delay > 0) await this.sleep(delay);
      }
    }
  }

  async get(key) {
    if (typeof key !== 'string' || !key.startsWith('orient/evidence-anchors/v1/')) {
      fail('EVIDENCE_ANCHOR_S3_INPUT_INVALID', 'A namespaced anchor key is required');
    }
    try {
      const result = await this.client.send(new this.commands.GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      }));
      return await bodyToUtf8(result?.Body);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async list(prefix) {
    if (typeof prefix !== 'string' || !prefix.startsWith('orient/evidence-anchors/v1/')) {
      fail('EVIDENCE_ANCHOR_S3_INPUT_INVALID', 'A namespaced anchor prefix is required');
    }
    const keys = [];
    const seenKeys = new Set();
    const seenTokens = new Set();
    let continuationToken;
    do {
      const result = await this.client.send(new this.commands.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {})
      }));
      const contents = result?.Contents ?? [];
      if (!Array.isArray(contents)) {
        fail('EVIDENCE_ANCHOR_S3_RESPONSE_INVALID', 'S3 listing Contents must be an array');
      }
      for (const item of contents) {
        if (typeof item?.Key !== 'string' || !item.Key.startsWith(prefix)) {
          fail('EVIDENCE_ANCHOR_S3_RESPONSE_INVALID', 'S3 returned an object outside the requested prefix');
        }
        if (seenKeys.has(item.Key)) {
          fail('EVIDENCE_ANCHOR_S3_DUPLICATE_KEY', 'S3 returned a duplicate object key across listing pages');
        }
        seenKeys.add(item.Key);
        keys.push(item.Key);
      }
      if (result?.IsTruncated) {
        const next = result.NextContinuationToken;
        if (typeof next !== 'string' || !next || seenTokens.has(next)) {
          fail('EVIDENCE_ANCHOR_S3_PAGINATION_INVALID', 'S3 returned an invalid or repeated continuation token');
        }
        seenTokens.add(next);
        continuationToken = next;
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    const entries = new Array(keys.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.maxConcurrentReads, keys.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= keys.length) return;
        const key = keys[index];
        entries[index] = { key, value: await this.get(key) };
      }
    }));

    if (entries.some(entry => entry.value === null)) {
      fail('EVIDENCE_ANCHOR_S3_LIST_RACE', 'An object listed by S3 could not be read back');
    }
    return entries;
  }
}

module.exports = { S3ObjectLockEvidenceAnchorBackend };
