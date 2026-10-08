const FailureClassifier = require('./failure-classifier');

const RETRYABLE_ERRORS = Object.freeze([
  'TIMEOUT',
  'TEMPORARY_FAILURE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'NETWORK_ERROR',
  'UPSTREAM_FAILURE'
]);

const RETRYABLE_CLASSES = Object.freeze([
  FailureClassifier.FAILURE_CLASSES.TRANSIENT,
  FailureClassifier.FAILURE_CLASSES.EXTERNAL
]);

class RetryPolicy {
  constructor({
    maxAttempts = 2,
    classifier = null
  } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer');
    }

    this.maxAttempts = maxAttempts;
    this.classifier = classifier || new FailureClassifier();
  }

  canRetry({ tool, error, attempt = 0 } = {}) {
    if (!tool) {
      return { allowed: false, reason: 'الأداة غير موجودة', failureClass: 'unknown' };
    }

    if (!tool.retryable) {
      return {
        allowed: false,
        reason: 'الأداة غير معلنة كآمنة لإعادة المحاولة',
        failureClass: this.classifier.classify(error)
      };
    }

    const failureClass = this.classifier.classify(error);
    const retryableByCode = RETRYABLE_ERRORS.includes(error && error.code);

    if (!retryableByCode && !RETRYABLE_CLASSES.includes(failureClass)) {
      return {
        allowed: false,
        reason: 'نوع الخطأ غير قابل لإعادة المحاولة',
        failureClass
      };
    }

    if (attempt >= this.maxAttempts) {
      return {
        allowed: false,
        reason: 'تم الوصول إلى الحد الأقصى للمحاولات',
        failureClass
      };
    }

    return {
      allowed: true,
      reason: 'الأداة والخطأ يسمحان بإعادة المحاولة',
      failureClass,
      attempt: attempt + 1,
      maxAttempts: this.maxAttempts
    };
  }
}

RetryPolicy.RETRYABLE_ERRORS = RETRYABLE_ERRORS;
RetryPolicy.RETRYABLE_CLASSES = RETRYABLE_CLASSES;

module.exports = RetryPolicy;
