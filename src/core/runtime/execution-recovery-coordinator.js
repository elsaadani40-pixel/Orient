'use strict';

class ExecutionRecoveryCoordinator {
  constructor({ agentOrchestrator, persistExecution, persistEvents, checkpoint }) {
    if (!agentOrchestrator) throw new TypeError('agentOrchestrator is required');
    if (typeof persistExecution !== 'function') throw new TypeError('persistExecution is required');
    if (typeof persistEvents !== 'function') throw new TypeError('persistEvents is required');
    if (typeof checkpoint !== 'function') throw new TypeError('checkpoint is required');

    this.agentOrchestrator = agentOrchestrator;
    this.persistExecution = persistExecution;
    this.persistEvents = persistEvents;
    this.checkpoint = checkpoint;
  }

  async classify(context, error) {
    const recovery = await this.agentOrchestrator.recover(error, context);
    const serialized =
      typeof recovery?.toJSON === 'function'
        ? recovery.toJSON()
        : recovery;

    context.record('recovery.started', {
      action: serialized?.action,
      reason: serialized?.reason,
      target: serialized?.target,
      metadata: serialized?.metadata
    });

    return serialized;
  }

  async fail({ context, error, checkpointReason = null }) {
    if (
      context.isActive() &&
      context.canTransitionAgentTo('recovering')
    ) {
      context.transitionAgentTo('recovering');
    }

    const recovery = await this.classify(context, error);
    context.record('recovery.completed', recovery);
    context.fail(error);

    // The durable checkpoint is the recovery commit barrier. Persist the terminal
    // failure before secondary stores so a crash between stores can never leave
    // a resumable checkpoint after the execution has been irreversibly failed.
    await this.checkpoint(
      context,
      'update',
      checkpointReason || 'recovery_failure_committed'
    );

    await this.persistExecution(context, 'update');
    await this.persistEvents(context);

    if (checkpointReason) {
      await this.checkpoint(context, 'update', checkpointReason);
    }

    return recovery;
  }
}

module.exports = ExecutionRecoveryCoordinator;
