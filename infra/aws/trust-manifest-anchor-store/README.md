# ORIENT external Trust Manifest anchor bucket (AWS)

This Terraform module provisions a **dedicated S3 Object Lock bucket** for the externally anchored trust-manifest history consumed by `S3ObjectLockTrustManifestAnchorBackend`.

## Security boundary

Deploy this module with credentials for a dedicated **anchor-storage AWS account**, not the account that runs ORIENT Runtime. Supply the Runtime role ARN as a cross-account principal. The module does not create or administer the Runtime role.

The bucket owner controls the retention configuration and bucket policy. The Runtime role receives only:
- `s3:ListBucket` constrained to `orient/trust-manifests/v1/*`
- `s3:GetObject` and `s3:PutObject` constrained to that object prefix

The bucket policy explicitly denies that Runtime role object deletion, retention changes, legal-hold changes, bucket versioning/retention configuration changes, lifecycle changes, and bucket deletion. The adapter deliberately sends **no per-object retention headers** for this backend: S3 applies the bucket-owned default COMPLIANCE retention. This prevents a compromised Runtime configuration from choosing a shorter retention period on an individual write.

The Runtime account administrator must separately grant the role the matching identity-side `s3:ListBucket`, `s3:GetObject`, and `s3:PutObject` permissions. Cross-account access requires both the Runtime role's identity policy and this bucket resource policy.

## Inputs

- `aws_region`: storage account region.
- `bucket_name`: globally unique, dedicated bucket name.
- `runtime_role_arn`: exact role ARN from the separate Runtime account.
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
  -var='runtime_role_arn=arn:aws:iam::111122223333:role/orient-runtime-anchor-writer' \
  -var='retention_days=365' # example only; choose and approve the retention period first
```

Review the plan and the target AWS account before running `terraform apply`. Applying provisions billable AWS resources; this repository change does not deploy anything.

## Runtime adapter

Construct `S3ObjectLockTrustManifestAnchorBackend` with an AWS SDK for JavaScript v3 S3 client, its `PutObjectCommand`, `GetObjectCommand`, `ListObjectsV2Command`, `GetObjectLockConfigurationCommand`, and `GetBucketVersioningCommand` constructors, the bucket name, and `expectedRetentionDays` matching the approved Terraform input. Before any read, list, or write, the adapter verifies that versioning is enabled and that the bucket's default COMPLIANCE retention exactly matches the expected number of days. It caches that successful configuration check for the adapter lifetime and retries after a failed check. Do not pass a Runtime-controlled retention duration: the bucket default is authoritative, and the adapter sends no per-object retention headers.

The adapter writes only under `orient/trust-manifests/v1/`, uses conditional `IfNoneMatch: '*'`, and has no overwrite or delete method. The external ledger verifies root signatures, canonical bytes, version ordering, and gaps after reading the stored history.

## Required operational verification

After a separately authorized deployment, capture evidence for:
1. Bucket account ID and region differ from the Runtime account.
2. Object Lock is enabled and versioning is enabled.
3. Default retention mode is COMPLIANCE with the approved duration.
4. Public access block and bucket-owner-enforced ownership are active.
5. Effective bucket policy denies Runtime deletion, retention/legal-hold changes, and bucket configuration changes.
6. Runtime role can list/read/create only within the trust-manifest prefix and cannot delete or alter retention.
7. A write/read/restart recovery drill succeeds using the real AWS SDK and account.
8. CloudTrail / audit records and an independently administered recovery procedure are retained.

Fake-client unit tests verify adapter command behavior only. They do not establish these account-level facts. No AWS credentials, bucket, IAM role, or cloud resource is created by this repository change.
