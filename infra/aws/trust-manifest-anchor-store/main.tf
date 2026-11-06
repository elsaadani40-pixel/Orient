terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_s3_bucket" "trust_manifest" {
  bucket              = var.bucket_name
  object_lock_enabled = true
  force_destroy       = false

  tags = {
    Project   = "ORIENT"
    Component = "trusted-evidence"
    DataClass = "trust-manifest"
    ManagedBy = "Terraform"
  }
}

resource "aws_s3_bucket_versioning" "trust_manifest" {
  bucket = aws_s3_bucket.trust_manifest.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "trust_manifest" {
  bucket = aws_s3_bucket.trust_manifest.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.trust_manifest]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trust_manifest" {
  bucket = aws_s3_bucket.trust_manifest.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "trust_manifest" {
  bucket                  = aws_s3_bucket.trust_manifest.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "trust_manifest" {
  bucket = aws_s3_bucket.trust_manifest.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "trust_manifest_bucket" {
  statement {
    sid    = "AllowTrustStoreServiceBucketInspection"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [var.trust_store_service_role_arn]
    }

    actions = [
      "s3:ListBucket",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketVersioning"
    ]

    resources = [aws_s3_bucket.trust_manifest.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["orient/trust-manifests/v1/*"]
    }
  }

  statement {
    sid    = "AllowTrustStoreServiceReadAndCreateObjects"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [var.trust_store_service_role_arn]
    }

    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]

    resources = ["${aws_s3_bucket.trust_manifest.arn}/orient/trust-manifests/v1/*"]
  }
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.trust_manifest.arn,
      "${aws_s3_bucket.trust_manifest.arn}/*"
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyTrustStoreServiceDestructiveOperations"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:BypassGovernanceRetention",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
      "s3:PutBucketEncryption",
      "s3:DeleteBucketEncryption",
      "s3:PutBucketPublicAccessBlock",
      "s3:DeletePublicAccessBlock",
      "s3:PutBucketOwnershipControls",
      "s3:DeleteBucketOwnershipControls",
      "s3:PutBucketTagging",
      "s3:DeleteBucketTagging",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
      "s3:DeleteBucket"
    ]

    resources = [
      aws_s3_bucket.trust_manifest.arn,
      "${aws_s3_bucket.trust_manifest.arn}/*"
    ]

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [var.trust_store_service_role_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "trust_manifest" {
  bucket = aws_s3_bucket.trust_manifest.id
  policy = data.aws_iam_policy_document.trust_manifest_bucket.json

  depends_on = [
    aws_s3_bucket_public_access_block.trust_manifest,
    aws_s3_bucket_ownership_controls.trust_manifest
  ]
}
