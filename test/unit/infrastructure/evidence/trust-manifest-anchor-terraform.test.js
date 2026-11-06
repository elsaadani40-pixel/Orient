'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleDirectory = path.join(__dirname, '../../../../infra/aws/trust-manifest-anchor-store');
const main = fs.readFileSync(path.join(moduleDirectory, 'main.tf'), 'utf8');
const variables = fs.readFileSync(path.join(moduleDirectory, 'variables.tf'), 'utf8');
const readme = fs.readFileSync(path.join(moduleDirectory, 'README.md'), 'utf8');

test('trust-manifest bucket grants access only to the dedicated trust-store service identity', () => {
  assert.match(variables, /variable "trust_store_service_role_arn"/);
  assert.doesNotMatch(variables, /runtime_role_arn/);
  assert.match(main, /identifiers = \[var\.trust_store_service_role_arn\]/);
  assert.doesNotMatch(main, /var\.runtime_role_arn/);
  assert.match(readme, /Do not use the Runtime application role/i);
});

test('trust-store service can inspect bucket controls without a prefix condition', () => {
  const bucketInspection = main.match(/sid\s*=\s*"AllowTrustStoreServiceBucketConfigurationRead"[\s\S]*?resources\s*=\s*\[aws_s3_bucket\.trust_manifest\.arn\]/);
  const listing = main.match(/sid\s*=\s*"AllowTrustStoreServiceListManifestPrefix"[\s\S]*?resources\s*=\s*\[aws_s3_bucket\.trust_manifest\.arn\]/);
  assert.ok(bucketInspection, 'bucket configuration reads must target the bucket ARN');
  assert.ok(listing, 'prefix listing must be a separate bucket-level permission');
  assert.match(listing[0], /"s3:ListBucket"/);
  assert.match(listing[0], /s3:prefix/);
  assert.doesNotMatch(listing[0], /GetBucketObjectLockConfiguration|GetBucketVersioning/);
  assert.match(bucketInspection[0], /"s3:GetBucketObjectLockConfiguration"/);
  assert.match(bucketInspection[0], /"s3:GetBucketVersioning"/);
  assert.doesNotMatch(bucketInspection[0], /s3:prefix/);
});

test('trust-store object permissions stay prefix-scoped and deny destructive operations', () => {
  assert.match(main, /"s3:GetObject",[\s\S]*?"s3:PutObject"/);
  assert.match(main, /orient\/trust-manifests\/v1\/\*/);
  for (const action of [
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:BypassGovernanceRetention',
    's3:PutObjectRetention',
    's3:PutObjectLegalHold',
    's3:PutBucketObjectLockConfiguration',
    's3:PutBucketVersioning',
    's3:DeleteBucket'
  ]) {
    assert.ok(main.includes('"'+action+'"'), 'bucket policy must deny '+action);
  }
});

test('trust-manifest bucket requires conditional create-only writes', () => {
  assert.match(main, /sid\s*=\s*"DenyNonConditionalTrustManifestWrites"/);
  assert.match(main, /variable\s*=\s*"s3:if-none-match"/);
  assert.match(main, /values\s*=\s*\["true"\]/);
  assert.match(main, /sid\\s*=\\s*"DenyNonWildcardConditionalTrustManifestWrites"/);\n  assert.match(main, /test\\s*=\\s*"StringNotEquals"[\\s\\S]*?variable\\s*=\\s*"s3:if-none-match"[\\s\\S]*?values\\s*=\\s*\\["\\*"\\]/);\n});

test('deployment guide matches the adapter no-cache configuration-drift check', () => {
  assert.match(readme, /re-reads Object Lock, versioning, and the exact default COMPLIANCE retention/i);
  assert.match(readme, /does not cache a successful configuration check/i);
});
