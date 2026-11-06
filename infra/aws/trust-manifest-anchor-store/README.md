# ORIENT external Trust Manifest anchor bucket (AWS)

This Terraform module provisions a **dedicated S3 Object Lock bucket** for the externally anchored trust-manifest history consumed by `S3ObjectLockTrustManifestAnchorBackend`.

## Security boundary

Deploy this module into a dedicated **anchor-storage AWS account**, separate from the account that runs ORIENT Runtime. Supply the ARN of a separately operated **trust-store service role**. Do not use the Runtime application role: the service that accepts and anchors root-signed trust manifests must be independently administered and must not share Runtime credentials.

The trust-store service role receives only:
- `s3:ListBucket` constrained to `orient/trust-manifests/v1/*`
- `s3:GetObject` for objects under that prefix
- `s3:PutObject` for objects under that prefix, with the bucket policy requiring `If-None-Match: *`
- `s3:GetBucketObjectLockConfiguration` and `s3:GetBucketVersioning` for the adapter's configuration preflight

The bucket policy separates prefix-scoped object listing from bucket-level configuration reads; the latter do not carry an `s3:prefix` condition. It denies trust-store service deletion, retention/legal-hold changes, bucket configuration changes, and bucket deletion. It also denies `PutObject` requests that omit the conditional `If-None-Match` header, so create-only behavior is enforced by S3 policy rather than relying only on the adapter to send the header.

The adapter deliberately sends **no per-object retention headers** for this backend: S3 applies the bucket-owned default COMPLIANCE retention. This prevents service configuration from choosing a shorter retention period on an individual write.

The service account administrator must separately grant the role matching identity-side permissions. Cross-account access requires both the role's identity policy and this bucket resource policy.

## Inputs

- `aws_region`: storage account region.
- `bucket_name`: globally unique, dedicated bucket name.
- `trust_store_service_role_arn`: exact ARN of the independently operated trust-store service role. It must not be the ORIENT Runtime application role.
- `retention_days`: required default COMPLIANCE retention in whole days. There is deliberately no default because COMPLIANCE retention is difficult to reverse and can create long-lived storage costs.

## Review before apply

Object Lock COMPLIANCE retention is intentionally difficult to reverse: an object version cannot be deleted or have its retention shortened before its retention deadline, including by the account root user. Retention settings may also create long-lived storage costs. Do not point this module at an existing production bucket or apply it without an explicit retention and recovery decision.

Example:

```sh
terraform init
terraform fmt -check
terraform validate
terraform plan \
  -var='aws_region=eu-central-1' \
  -var='bucket_name=replace-with-globally-unique-name' \
  -var='trust_store_service_role_arn=arn:aws:iam::111122223333:role/orient-trust-store-service' \
  -var='retention_days=365' # example only; choose and approve the retention period first
```

Review the plan and the target AWS account before running `terraform apply`. Applying provisions billable AWS resources; this repository change does not deploy anything.

## Trust-store service adapter

Construct `S3ObjectLockTrustManifestAnchorBackend` with an AWS SDK for JavaScript v3 S3 client, its `PutObjectCommand`, `GetObjectCommand`, `ListObjectsV2Command`, `GetObjectLockConfigurationCommand`, and `GetBucketVersioningCommand` constructors, the bucket name, and `expectedRetentionDays` matching the approved Terraform input.

Before every read, list, or write, the adapter re-reads Object Lock, versioning, and the exact default COMPLIANCE retention. It deliberately does not cache a successful configuration check, so a long-running process can detect drift on its next operation. The check is not atomic with a concurrent privileged administrator changing bucket configuration; production change windows must pause trust writes while configuration is modified.

The adapter writes only under `orient/trust-manifests/v1/`, uses conditional `IfNoneMatch: '*'`, and has no overwrite or delete method. The bucket policy independently rejects writes that omit the conditional header. The external ledger verifies root signatures, canonical bytes, version ordering, and gaps after reading the stored history.

## Required operational verification

After a separately authorized deployment, capture evidence for:
1. Bucket account ID and region differ from the Runtime account.
2. Object Lock is enabled and versioning is enabled.
3. Default retention mode is COMPLIANCE with the explicitly approved duration.
4. Public access block and bucket-owner-enforced ownership are active.
5. Effective bucket policy denies service-role deletion, retention/legal-hold changes, and bucket configuration changes.
6. The service role can list/read/create only within the trust-manifest prefix; it cannot write without `If-None-Match: *`, delete objects, or alter retention.
7. A write/read/restart recovery drill succeeds using the real AWS SDK and account.
8. CloudTrail / audit records and an independently administered recovery procedure are retained.

Fake-client unit tests verify adapter command behavior only. They do not establish these account-level facts. No AWS credentials, bucket, IAM role, or cloud resource is created by this repository change.
