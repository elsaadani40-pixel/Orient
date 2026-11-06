variable "aws_region" {
  description = "AWS region for the independently administered trust-manifest bucket."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique dedicated S3 bucket name. Object Lock is enabled at creation."
  type        = string

  validation {
    condition     = length(var.bucket_name) >= 3 && length(var.bucket_name) <= 63 && can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid 3-63 character lowercase S3 bucket name."
  }
}

variable "retention_days" {
  description = "Default COMPLIANCE retention for all objects. Compliance retention cannot be shortened."
  type        = number
  default     = 365

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 36500 && floor(var.retention_days) == var.retention_days
    error_message = "retention_days must be a whole number between 1 and 36500."
  }
}

variable "runtime_role_arn" {
  description = "Exact ARN of the runtime role, used by the bucket policy to deny destructive operations."
  type        = string
}
