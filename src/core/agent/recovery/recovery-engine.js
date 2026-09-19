const RecoveryAction = require('./recovery-action');

class RecoveryEngine {
  recover(error) {
    const code = error && error.code;

    if (
      code === 'TIMEOUT' ||
      code === 'TEMPORARY_FAILURE'
    ) {
      return new RecoveryAction({
        action: RecoveryAction.ACTIONS.RETRY,
        reason: 'خطأ مؤقت؛ إعادة المحاولة',
        metadata: {
          retryable: true
        }
      });
    }

    if (
      code === 'TOOL_NOT_FOUND' ||
      code === 'TOOL_NOT_REGISTERED'
    ) {
      return new RecoveryAction({
        action: RecoveryAction.ACTIONS.ALTERNATIVE,
        reason: 'الأداة غير متاحة؛ البحث عن بديل',
        metadata: {
          requiresAlternative: true
        }
      });
    }

    if (code === 'APPROVAL_REQUIRED') {
      return new RecoveryAction({
        action: RecoveryAction.ACTIONS.APPROVAL,
        reason: 'المهمة تحتاج موافقة',
        metadata: {
          requiresApproval: true
        }
      });
    }

    if (code === 'INVALID_INPUT') {
      return new RecoveryAction({
        action: RecoveryAction.ACTIONS.REPLAN,
        reason: 'المدخلات غير صالحة؛ إعادة التخطيط',
        metadata: {
          replanRequired: true
        }
      });
    }

    return new RecoveryAction({
      action: RecoveryAction.ACTIONS.ABORT,
      reason: 'خطأ غير قابل للتعافي',
      metadata: {
        retryable: false
      }
    });
  }
}

module.exports = RecoveryEngine;
