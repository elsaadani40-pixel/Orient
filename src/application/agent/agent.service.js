const AppError = require('../../core/errors/AppError');

class AgentService {
  constructor(runtime) {
    this.runtime = runtime;
  }

  execute(input) {
    const clean = String(input || '').trim();

    if (!clean) {
      throw new AppError(
        'الطلب مطلوب',
        400,
        'AGENT_INPUT_REQUIRED'
      );
    }

    if (clean.length > 5000) {
      throw new AppError(
        'الطلب طويل جدًا',
        400,
        'AGENT_INPUT_TOO_LONG'
      );
    }

    return this.runtime.execute(clean);
  }

  getExecutionStatus(executionId) {
    return this.runtime.getExecutionStatus(executionId);
  }

  resumeExecution(executionId, options = {}) {
    return this.runtime.resume(executionId, options);
  }
}

module.exports = AgentService;
