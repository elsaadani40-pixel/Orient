'use strict';

class AgentExecutionCoordinator {
  constructor({ agentOrchestrator, agentLoop, checkpoint, maxReplans = 3, validateReplannedPlan }) {
    if (!agentOrchestrator) throw new TypeError('agentOrchestrator is required');
    if (!agentLoop) throw new TypeError('agentLoop is required');
    if (typeof checkpoint !== 'function') throw new TypeError('checkpoint is required');
    if (typeof validateReplannedPlan !== 'function') throw new TypeError('validateReplannedPlan is required');
    this.agentOrchestrator = agentOrchestrator;
    this.agentLoop = agentLoop;
    this.checkpoint = checkpoint;
    this.maxReplans = maxReplans;
    this.validateReplannedPlan = validateReplannedPlan;
  }

  async run({ context, plan, validation, planRevision = 1, replans = 0, previousFingerprint, approval = null, approvals = {}, requestId = context.requestId, input = context.input, tenantId, agentId = null, resumed = false, isCancellationRequested = null, cancellationReason = null }) {
    let loopResult = null;
    let replanningDecision = null;
    let currentPlan = plan;
    let currentValidation = validation;
    let currentRevision = planRevision;
    let currentReplans = replans;
    let fingerprint = previousFingerprint;

    while (true) {
      if (!currentValidation || currentValidation.valid !== true || !Array.isArray(currentValidation.steps)) {
        context.record('plan.validation.rejected', {
          valid: currentValidation?.valid === true,
          steps: Array.isArray(currentValidation?.steps) ? currentValidation.steps.length : 0,
          planRevision: currentRevision,
          resumed
        });
        throw Object.assign(
          new Error(resumed ? 'الخطة المستعادة غير صالحة للتنفيذ' : 'الخطة غير صالحة للتنفيذ'),
          { code: resumed ? 'INVALID_RESUME_PLAN' : 'INVALID_PLAN_VALIDATION' }
        );
      }

      if (!resumed) {
        context.record('plan.generated', {
          intent: currentPlan.intent,
          confidence: currentPlan.confidence,
          planRevision: currentRevision,
          replan: currentRevision > 1
        });
        context.transitionAgentTo('validating');
        context.record('plan.validation.completed', {
          valid: currentValidation.valid,
          steps: currentValidation.steps.length,
          planRevision: currentRevision
        });
      }

      context.setPlan(currentPlan);
      const lifecycle = context.getAgentLifecycle && context.getAgentLifecycle();
      if (lifecycle !== 'executing') context.transitionAgentTo('executing');
      loopResult = await this.agentLoop.run({
        plan: currentPlan,
        context,
        runtimeContext: {
          requestId,
          input,
          plan: currentPlan,
          planRevision: currentRevision,
          approval,
          approvals,
          tenantId,
          agentId: currentPlan.agentId || agentId || 'ORIENT_RUNTIME',
          isCancellationRequested,
          cancellationReason,
          onCheckpoint: async ({ step, planRevision: checkpointPlanRevision, reason = resumed ? 'resume_step_completed' : 'step_completed' } = {}) => {
            context.metadata.planRevision = checkpointPlanRevision;
            context.metadata.replans = currentReplans;
            return this.checkpoint(context, 'update', reason + ':plan-' + checkpointPlanRevision + ':step-' + step);
          }
        }
      });

      if (typeof isCancellationRequested === 'function' && isCancellationRequested()) {
        const reason = cancellationReason || 'Execution cancellation requested';
        context.requestCancellation(reason);
        throw Object.assign(new Error('Execution cancellation requested'), { code: 'EXECUTION_CANCELLATION_REQUESTED' });
      }

      context.transitionAgentTo('observing');
      context.record('observations.collected', { count: context.observations.length, planRevision: currentRevision });
      context.transitionAgentTo('evaluating');
      replanningDecision = this.agentOrchestrator.decideReplanning({
        evaluation: loopResult.evaluation,
        replans: currentReplans,
        hasRemainingSteps: loopResult.stepsExecuted < currentPlan.steps.length,
        context
      });
      context.record('replanning.decision', { ...replanningDecision.toJSON(), planRevision: currentRevision, replans: currentReplans, ...(resumed ? { resumed: true } : {}) });

      if (replanningDecision.nextAction !== 'replan') break;
      if (currentReplans >= this.maxReplans) throw Object.assign(new Error('تم الوصول إلى الحد الأقصى لإعادة التخطيط'), { code: 'MAX_REPLANS_EXCEEDED' });

      const nextOrchestration = await this.agentOrchestrator.replan({ input, evaluation: loopResult.evaluation, previousPlan: currentPlan, context });
      if (!nextOrchestration?.plan || nextOrchestration.validation?.valid !== true) {
        throw Object.assign(new Error(resumed ? 'الخطة المستعادة لم تجتز إعادة التخطيط' : 'الخطة الجديدة لم تجتز التحقق'), { code: resumed ? 'INVALID_RESUME_REPLAN' : 'INVALID_REPLAN_VALIDATION' });
      }
      const nextPlan = nextOrchestration.plan;
      const replanValidation = this.validateReplannedPlan(nextPlan, fingerprint);
      if (!replanValidation.valid) throw Object.assign(new Error(replanValidation.reason), { code: 'INVALID_REPLAN' });

      currentReplans += 1;
      currentRevision += 1;
      context.metadata.planRevision = currentRevision;
      context.metadata.replans = currentReplans;
      if (!resumed) context.metadata.agentId = currentPlan.agentId || context.metadata.agentId || 'ORIENT_RUNTIME';
      fingerprint = replanValidation.fingerprint;
      context.record('replanning.executed', {
        replans: currentReplans,
        planRevision: currentRevision,
        previousPlanIntent: currentPlan.intent,
        nextPlanIntent: nextPlan.intent,
        ...(resumed ? { resumed: true } : {})
      });
      currentPlan = nextPlan;
      currentValidation = nextOrchestration.validation;
      context.transitionAgentTo('planning');
      resumed = false;
    }

    return { plan: currentPlan, validation: currentValidation, planRevision: currentRevision, replans: currentReplans, previousFingerprint: fingerprint, loopResult, replanningDecision };
  }
}

module.exports = AgentExecutionCoordinator;

