'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../../../..');
const terraformPath = path.join(moduleRoot, 'infra/aws/trust-manifest-anchor-store/main.tf');
const readmePath = path.join(moduleRoot, 'infra/aws/trust-manifest-anchor-store/README.md');
const terraform = fs.readFileSync(terraformPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');

function policyStatement(sid) {
  const marker = `sid    = "${sid}"`;
  const start = terraform.indexOf(marker);
  assert.notEqual(start, -1, `missing bucket policy statement: ${sid}`);
  const next = terraform.indexOf('  statement {', start + marker.length);
  return terraform.slice(start, next === -1 ? terraform.length : next);
}

test('trust-store bucket listing prefix does not constrain bucket configuration reads', () => {
  const listing = policyStatement('AllowTrustStoreServiceListManifestPrefix');
  const configuration = policyStatement('AllowTrustStoreServiceBucketConfigurationRead');

  assert.match(listing, /s3:ListBucket/);
  assert.match(listing, /s3:prefix/);
  assert.doesNotMatch(listing, /GetBucketObjectLockConfiguration|GetBucketVersioning/);

  assert.match(configuration, /s3:GetBucketObjectLockConfiguration/);
  assert.match(configuration, /s3:GetBucketVersioning/);
  assert.doesNotMatch(configuration, /s3:prefix/);
});

test('trust-store bucket policy requires conditional create-only object writes', () => {
  const conditional = policyStatement('DenyNonConditionalTrustManifestWrites');

  assert.match(conditional, /s3:PutObject/);
  assert.match(conditional, /s3:if-none-match/);
  assert.match(conditional, /values\s*=\s*\["true"\]/);
  assert.match(terraform, /IfNoneMatch:\s*"\*"/);
});

test('trust-store Terraform inputs and operator documentation use the isolated service role', () => {
  const variables = fs.readFileSync(
    path.join(moduleRoot, 'infra/aws/trust-manifest-anchor-store/variables.tf'),
    'utf8'
  );

  assert.match(variables, /variable "trust_store_service_role_arn"/);
  assert.doesNotMatch(variables, /variable "runtime_role_arn"/);
  assert.match(readme, /trust_store_service_role_arn/);
  assert.match(readme, /separately operated trust-store service role/i);
  assert.doesNotMatch(readme, /runtime_role_arn/);
});
