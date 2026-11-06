output "bucket_name" {
  description = "Dedicated immutable trust-manifest bucket name."
  value       = aws_s3_bucket.trust_manifest.bucket
}

output "bucket_arn" {
  description = "Bucket ARN for audit and monitoring."
  value       = aws_s3_bucket.trust_manifest.arn
}

output "object_lock_mode" {
  description = "Default retention mode configured for newly written objects."
  value       = "COMPLIANCE"
}

output "retention_days" {
  description = "Configured default compliance retention."
  value       = var.retention_days
}
