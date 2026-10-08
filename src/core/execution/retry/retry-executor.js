const AppError = require('../../errors/AppError');
const RetryPolicy = require('../policy/retry-policy');
const CircuitBreaker = require('../circuit-breaker');
const FailureClassifier = require('../policy/failure-classifier');

class RetryExecutor {
  constructor({
    policy = null,
    delay = null,
    circuitBreaker = null,
    classifier = null,
    baseDelayMs = 25,
    maxDelayMs = 1000,
    jitterRatio = 0.2,
    random = Math.random
  } = {}) {
    this.policy = policy || new RetryPolicy({ maxAttempts: 2 });
    this.classifier = classifier || this.policy.classifier || new FailureClassifier();
    this.circuitBreaker = circuitBreaker || new CircuitBreaker();
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.jitterRatio = jitterRatio;
    this.random = random;

    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
      throw new TypeError('baseDelayMs must be a non-negative integer');
    }
    if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
      throw new TypeError('maxDelayMs must be an integer >= baseDelayMs');
    }
    if (typeof random !== 'function') throw new TypeError('random must be a function');

    this.delay = typeof delay === 'function'
      ? delay
      : async ({ nextAttempt }) => {
          const exponential = Math.min(
            this.maxDelayMs,
            this.baseDelayMs * (2 ** Math.max(0, nextAttempt - 1))
          );
          const jitter = exponential * this.jitterRatio * this.random();
          const waitMs = Math.round(exponential + jitter);
          if (waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        };
  }

  async execute({ tool, execute, context = null, step = null }) {
    if (!tool) {
      throw new AppError('Tool definition is required', 500, 'RETRY_TOOL_REQUIRED');
    }
    if (typeof execute !== 'function') {
      throw new AppError('Retry execution callback is required', 500, 'RETRY_EXECUTOR_REQUIRED');
    }

    let attempt = 0;
    const circuitKey = tool.name;

    while (attempt < this.policy.maxAttempts) {
      const currentAttempt = attempt + 1;

      try {
        const circuit = this.circuitBreaker.beforeRequest(circuitKey);
        if (context) {
          context.record('execution.circuit.checked', {
            step,
            tool: tool.name,
            state: circuit.state,
            failures: circuit.failures
          });
        }
      } catch (error) {
        if (context) {
          context.record('execution.circuit.blocked', {
            step,
            tool: tool.name,
            code: error.code || 'CIRCUIT_OPEN',
            reason: error.message
          });
        }
        throw error;
      }

      if (context) {
        context.record('execution.attempt.started', {
          step,
          tool: tool.name,
          attempt: currentAttempt,
          maxAttempts: this.policy.maxAttempts
        });
      }

      try {
        const result = await execute({ attempt: currentAttempt });
        this.circuitBreaker.recordSuccess(circuitKey);

        if (context) {
          context.record('execution.attempt.completed', {
            step,
            tool: tool.name,
            attempt: currentAttempt
          });
          context.record('execution.circuit.closed', {
            step,
            tool: tool.name
          });
        }

        return { result, attempts: currentAttempt };
      } catch (error) {
        const failureClass = this.classifier.classify(error);
        const decision = this.policy.canRetry({
          tool,
          error,
          attempt
        });

        const circuitCountsFailure = [
          FailureClassifier.FAILURE_CLASSES.TRANSIENT,
          FailureClassifier.FAILURE_CLASSES.EXTERNAL,
          FailureClassifier.FAILURE_CLASSES.RESOURCE
        ].includes(failureClass);

        if (circuitCountsFailure) {
          const status = this.circuitBreaker.recordFailure(circuitKey);
          if (context) {
            context.record('execution.circuit.failure', {
              step,
              tool: tool.name,
              failureClass,
              state: status.state,
              failures: status.failures
            });
          }
        }

        if (context) {
          context.record('execution.retry.evaluated', {
            step,
            tool: tool.name,
            attempt: currentAttempt,
            allowed: decision.allowed,
            reason: decision.reason,
            failureClass,
            nextAttempt: decision.allowed ? decision.attempt : null,
            maxAttempts: decision.maxAttempts || this.policy.maxAttempts
          });
        }

        if (!decision.allowed) throw error;

        if (context) {
          context.record('execution.retry.scheduled', {
            step,
            tool: tool.name,
            failedAttempt: currentAttempt,
            nextAttempt: decision.attempt,
            maxAttempts: this.policy.maxAttempts,
            reason: decision.reason,
            failureClass
          });
        }

        await this.delay({
          attempt: currentAttempt,
          nextAttempt: decision.attempt,
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
