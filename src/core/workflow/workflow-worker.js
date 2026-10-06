const crypto = require('crypto');
const WorkflowDefinition = require('./workflow-definition');

class WorkflowWorker {
  constructor({ scheduler, executor, eventSink = () => {}, workerId = crypto.randomUUID(), now = () => Date.now(), retryClassifier = () => true }) {
    this.scheduler = scheduler; this.executor = executor; this.eventSink = eventSink; this.workerId = workerId; this.now = now; this.retryClassifier = retryClassifier;
  }

  isDeadlineExceeded(lease) {
    return Boolean(lease.deadlineAt && new Date(lease.deadlineAt).getTime() <= this.now());
  }

  async tick() {
    const lease = this.scheduler.lease(this.workerId);
    if (!lease) return null;
    const instance = lease.instance;
    this.emit('workflow.lease.acquired', { workflowId: instance.workflowId, leaseId: lease.leaseId, workerId: this.workerId });
    try {
      while (true) {
        if (lease.cancelled || instance.cancelRequested) {
          if (instance.state !== 'CANCELLED') instance.transition('CANCELLED');
          this.emit('workflow.cancelled', { workflowId: instance.workflowId, leaseId: lease.leaseId }); break;
        }
        if (this.isDeadlineExceeded(lease)) {
          if (instance.state !== 'FAILED' && instance.state !== 'CANCELLED') instance.transition('FAILED');
          instance.metadata.deadlineExceeded = true; instance.metadata.failureCode = 'WORKFLOW_DEADLINE_EXCEEDED';
          this.emit('workflow.deadline.exceeded', { workflowId: instance.workflowId, leaseId: lease.leaseId }); break;
        }

        this.scheduler.renew(instance.workflowId, lease.leaseId);
        const ready = instance.readySteps();
        if (!ready.length) {
          const allCompleted = instance.definition.steps.every(step => instance.steps[step.id].state === WorkflowDefinition.STEP_STATES.COMPLETED);
          if (allCompleted) instance.transition('COMPLETED');
          else if (instance.state !== 'FAILED' && instance.state !== 'CANCELLED') instance.transition('FAILED');
          break;
        }

        const step = ready[0];
        instance.markStepRunning(step.id);
        instance.metadata.failedStepId = null;
        this.emit('workflow.step.started', { workflowId: instance.workflowId, leaseId: lease.leaseId, stepId: step.id, attempt: instance.steps[step.id].attempts });

        try {
          const result = await this.executor({ instance, step, lease });
          if (instance.cancelRequested) {
            instance.cancelStep(step.id); instance.transition('CANCELLED');
            this.emit('workflow.cancelled', { workflowId: instance.workflowId, leaseId: lease.leaseId, stepId: step.id }); break;
          }
          if (this.isDeadlineExceeded(lease)) {
            instance.markStepFailed(step.id, Object.assign(new Error('Workflow deadline exceeded'), { code: 'WORKFLOW_DEADLINE_EXCEEDED' }));
            instance.transition('FAILED');
            this.emit('workflow.deadline.exceeded', { workflowId: instance.workflowId, leaseId: lease.leaseId, stepId: step.id }); break;
          }
          instance.markStepCompleted(step.id, result);
          this.emit('workflow.step.completed', { workflowId: instance.workflowId, leaseId: lease.leaseId, stepId: step.id });
        } catch (error) {
          instance.markStepFailed(step.id, error); instance.metadata.failedStepId = step.id;
          this.emit('workflow.step.failed', { workflowId: instance.workflowId, leaseId: lease.leaseId, stepId: step.id, error: { message: error?.message, code: error?.code } });
          const retryable = this.retryClassifier(error, { instance, step, lease });
          const retried = retryable && this.scheduler.retry(instance, { error, priority: instance.metadata.priority || 0 });
          if (retried) {
            this.emit('workflow.retry.scheduled', { workflowId: instance.workflowId, leaseId: lease.leaseId, stepId: step.id, retryAttempt: instance.retry.attempt, nextAttemptAt: instance.retry.nextAttemptAt });
          } else {
            if (instance.state !== 'FAILED') instance.transition('FAILED');
            instance.metadata.failureCode = error?.code || 'WORKFLOW_STEP_FAILED';
          }
          break;
        }
      }
      return instance;
    } finally {
      this.scheduler.release(instance.workflowId, lease.leaseId);
      this.emit('workflow.lease.released', { workflowId: instance.workflowId, leaseId: lease.leaseId, workerId: this.workerId });
    }
  }

  emit(type, payload) {
    this.eventSink({ eventId: crypto.randomUUID(), type, timestamp: new Date(this.now()).toISOString(), payload });
  }
}
module.exports = WorkflowWorker;
