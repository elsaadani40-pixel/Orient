const AppError = require('../../errors/AppError');
const RetryPolicy = require('../policy/retry-policy');

class RetryExecutor {
  constructor({
    policy = null,
    delay = null
  } = {}) {
    this.policy =
      policy ||
      new RetryPolicy({
        maxAttempts: 2
      });

    this.delay =
      typeof delay === 'function'
        ? delay
        : async () => {};
  }

  async execute({
    tool,
    execute,
    context = null,
    step = null
  }) {
    if (!tool) {
      throw new AppError(
        'Tool definition is required',
        500,
        'RETRY_TOOL_REQUIRED'
      );
    }

    if (typeof execute !== 'function') {
      throw new AppError(
        'Retry execution callback is required',
        500,
        'RETRY_EXECUTOR_REQUIRED'
      );
    }

    let attempt = 0;

    while (attempt < this.policy.maxAttempts) {
      const currentAttempt =
        attempt + 1;

      if (context) {
        context.record(
          'execution.attempt.started',
          {
            step,
            tool: tool.name,
            attempt: currentAttempt,
            maxAttempts:
              this.policy.maxAttempts
          }
        );
      }

      try {
        const result =
          await execute({
            attempt: currentAttempt
          });

        if (context) {
          context.record(
            'execution.attempt.completed',
            {
              step,
              tool: tool.name,
              attempt: currentAttempt
            }
          );
        }

        return {
          result,
          attempts: currentAttempt
        };
      } catch (error) {
        const decision =
          this.policy.canRetry({
            tool,
            error,
            attempt
          });

        if (context) {
          context.record(
            'execution.retry.evaluated',
            {
              step,
              tool: tool.name,
              attempt: currentAttempt,
              allowed: decision.allowed,
              reason: decision.reason,
              nextAttempt:
                decision.allowed
                  ? decision.attempt
                  : null,
              maxAttempts:
                decision.maxAttempts ||
                this.policy.maxAttempts
            }
          );
        }

        if (!decision.allowed) {
          throw error;
        }

        if (context) {
          context.record(
            'execution.retry.scheduled',
            {
              step,
              tool: tool.name,
              failedAttempt: currentAttempt,
              nextAttempt:
                decision.attempt,
              maxAttempts:
                this.policy.maxAttempts,
              reason: decision.reason
            }
          );
        }

        await this.delay({
          attempt: currentAttempt,
          nextAttempt:
            decision.attempt,
          error,
          tool
        });

        attempt += 1;
      }
    }

    throw new AppError(
      'Retry attempts exhausted',
      500,
      'RETRY_ATTEMPTS_EXHAUSTED'
    );
  }
}

module.exports = RetryExecutor;
