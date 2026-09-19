const RETRYABLE_ERRORS = Object.freeze([
  'TIMEOUT',
  'TEMPORARY_FAILURE'
]);

class RetryPolicy {
  constructor({
    maxAttempts = 2
  } = {}) {
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1
    ) {
      throw new TypeError(
        'maxAttempts must be a positive integer'
      );
    }

    this.maxAttempts = maxAttempts;
  }

  canRetry({
    tool,
    error,
    attempt = 0
  } = {}) {
    if (!tool) {
      return {
        allowed: false,
        reason: 'الأداة غير موجودة'
      };
    }

    if (!tool.retryable) {
      return {
        allowed: false,
        reason: 'الأداة غير معلنة كآمنة لإعادة المحاولة'
      };
    }

    if (
      !RETRYABLE_ERRORS.includes(
        error && error.code
      )
    ) {
      return {
        allowed: false,
        reason: 'نوع الخطأ غير قابل لإعادة المحاولة'
      };
    }

    if (attempt >= this.maxAttempts) {
      return {
        allowed: false,
        reason: 'تم الوصول إلى الحد الأقصى للمحاولات'
      };
    }

    return {
      allowed: true,
      reason: 'الأداة والخطأ يسمحان بإعادة المحاولة',
      attempt: attempt + 1,
      maxAttempts: this.maxAttempts
    };
  }
}

RetryPolicy.RETRYABLE_ERRORS =
  RETRYABLE_ERRORS;

module.exports = RetryPolicy;
