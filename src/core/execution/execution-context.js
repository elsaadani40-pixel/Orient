const crypto = require('crypto');

const AgentState =
  require('../agent/state/agent-state');

const Goal =
  require('../goal/goal.entity');

const AgentStateMachine =
  require('../agent/state/agent-state-machine');

const EXECUTION_STATUS = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const TERMINAL_STATUSES = new Set([
  EXECUTION_STATUS.COMPLETED,
  EXECUTION_STATUS.FAILED,
  EXECUTION_STATUS.CANCELLED
]);

class ExecutionContext {
  constructor({
    requestId,
    input,
    executionId = null,
    goalId = null,
    parentExecutionId = null,
    tenantId = null,
    userId = null,
    workspaceId = null,
    metadata = {}
  } = {}) {
    if (!requestId) {
      throw new TypeError(
        'requestId is required'
      );
    }

    if (
      input === undefined ||
      input === null
    ) {
      throw new TypeError(
        'input is required'
      );
    }

    this.executionId =
      executionId ||
      crypto.randomUUID();

    this.requestId =
      String(requestId);

    this.goalId =
      goalId ||
      crypto.randomUUID();

    this.goal = new Goal({
      id: this.goalId,
      input,
      executionId: this.executionId,
      tenantId: tenantId || metadata.tenantId || null,
      userId: userId || metadata.userId || null,
      workspaceId: workspaceId || metadata.workspaceId || null
    });

    this.parentExecutionId =
      parentExecutionId || null;

    this.tenantId = tenantId || metadata.tenantId || null;
    this.userId = userId || metadata.userId || null;
    this.workspaceId = workspaceId || metadata.workspaceId || null;

    if (this.tenantId) this.metadataTenantGuard(metadata.tenantId, this.tenantId);
    if (this.userId) this.metadataTenantGuard(metadata.userId, this.userId);
    if (this.workspaceId) this.metadataTenantGuard(metadata.workspaceId, this.workspaceId);

    this.input =
      String(input);

    this.executionVersion = 1;

    this.metadata = {
      ...metadata,
      ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      ...(this.userId ? { userId: this.userId } : {}),
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {})
    };

    this.status =
      EXECUTION_STATUS.CREATED;

    this.agentState =
      new AgentState({
        agentId: 'default-agent',
        goalId: this.goalId
      });

    this.agentState.executionId =
      this.executionId;

    this.agentStateMachine =
      new AgentStateMachine(
        this.agentState
      );

    this.startedAt = null;
    this.completedAt = null;

    this.plan = null;
    this.tool = null;
    this.result = null;

    this.currentStep = 0;
    this.steps = [];
    this.observations = [];

    this.events = [];
  }

  metadataTenantGuard(metadataValue, explicitValue) {
    if (metadataValue && explicitValue && metadataValue !== explicitValue) {
      throw new TypeError('Identity metadata mismatch');
    }
  }

  identity() {
    return {
      executionId:
        this.executionId,

      requestId:
        this.requestId,

      goalId:
        this.goalId,

      parentExecutionId:
        this.parentExecutionId,

      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,

      executionVersion:
        this.executionVersion
    };
  }

  getAgentLifecycle() {
    return this.agentStateMachine
      .getState();
  }

  canTransitionAgentTo(
    nextState
  ) {
    return this.agentStateMachine
      .canTransitionTo(nextState);
  }

  transitionAgentTo(
    nextState
  ) {
    const previousState =
      this.getAgentLifecycle();

    this.agentStateMachine
      .transitionTo(nextState);

    this.record(
      'agent.lifecycle.changed',
      {
        from: previousState,
        to: nextState
      }
    );

    return this;
  }

  isActive() {
    return (
      this.status ===
      EXECUTION_STATUS.CREATED ||
      this.status ===
      EXECUTION_STATUS.RUNNING
    );
  }

  isTerminal() {
    return TERMINAL_STATUSES.has(
      this.status
    );
  }

  start() {
    if (
      this.status !==
      EXECUTION_STATUS.CREATED
    ) {
      throw new Error(
        `Cannot start execution from status "${this.status}"`
      );
    }

    this.status =
      EXECUTION_STATUS.RUNNING;

    this.goal.transitionTo(Goal.STATUS.RUNNING);

    this.record(
      'goal.started',
      this.goal.snapshot()
    );

    this.startedAt =
      new Date().toISOString();

    this.transitionAgentTo(
      AgentState.LIFECYCLE.UNDERSTANDING
    );

    this.record(
      'execution.started',
      this.identity()
    );

    return this;
  }

  setPlan(plan) {
    if (
      !plan ||
      typeof plan !== 'object'
    ) {
      throw new TypeError(
        'plan must be an object'
      );
    }

    this.plan = plan;

    this.agentState.currentPlan =
      plan;

    this.record(
      'plan.created',
      {
        intent: plan.intent,
        tool: plan.tool,
        confidence:
          plan.confidence
      }
    );

    return this;
  }

  startStep({
    step,
    tool,
    planRevision = 1,
    operationId = null
  }) {
    if (!this.isActive()) {
      throw new Error(
        `Cannot start step while execution is "${this.status}"`
      );
    }

    if (
      !Number.isInteger(step) ||
      step < 1
    ) {
      throw new TypeError(
        'step must be a positive integer'
      );
    }

    if (
      !tool ||
      typeof tool !== 'string'
    ) {
      throw new TypeError(
        'tool is required'
      );
    }

    this.currentStep =
      step;

    this.agentState.currentStep =
      step;

    const stepState = {
      step,
      planRevision,
      operationId,
      tool,
      status: 'running',
      startedAt:
        new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null
    };

    this.steps.push(
      stepState
    );

    this.record(
      'execution.step.started',
      {
        step,
        tool,
        planRevision,
        operationId
      }
    );

    return this;
  }

  setTool(toolName) {
    if (
      !toolName ||
      typeof toolName !== 'string'
    ) {
      throw new TypeError(
        'toolName is required'
      );
    }

    this.tool =
      toolName;

    this.record(
      'tool.selected',
      {
        tool: toolName
      }
    );

    return this;
  }

  completeStep({
    step,
    tool,
    result,
    planRevision = 1
  }) {
    const stepState =
      this.steps.find(
        (item) =>
          item.step === step &&
          Number(item.planRevision || 1) === planRevision
      );

    if (!stepState) {
      throw new Error(
        `Execution step "${step}" not found`
      );
    }

    stepState.status =
      'completed';

    stepState.completedAt =
      new Date().toISOString();

    stepState.result =
      result;

    this.result =
      result;

    this.record(
      'execution.step.completed',
      {
        step,
        tool,
        planRevision
      }
    );

    return this;
  }

  failStep({
    step,
    tool,
    error,
    planRevision = 1
  }) {
    const stepState =
      this.steps.find(
        (item) =>
          item.step === step &&
          Number(item.planRevision || 1) === planRevision
      );

    if (!stepState) {
      throw new Error(
        `Execution step "${step}" not found`
      );
    }

    const normalizedError = {
      code:
        error?.code ||
        'TOOL_EXECUTION_FAILED',

      message:
        error?.message ||
        String(error || '')
    };

    stepState.status =
      'failed';

    stepState.completedAt =
      new Date().toISOString();

    stepState.error =
      normalizedError;

    this.record(
      'execution.step.failed',
      {
        step,
        tool,
        planRevision,
        code:
          normalizedError.code
      }
    );

    return this;
  }

  addObservation({
    step,
    tool,
    success,
    result = null,
    error = null
  }) {
    const observation = {
      id:
        crypto.randomUUID(),

      executionId:
        this.executionId,

      step,
      tool,

      success:
        Boolean(success),

      timestamp:
        new Date().toISOString(),

      result,
      error
    };

    this.observations.push(
      observation
    );

    this.agentState.observations.push(
      observation
    );

    this.record(
      'observation.created',
      {
        step,
        tool,
        success:
          Boolean(success)
      }
    );

    return this;
  }

  setResult(result) {
    this.result =
      result;

    return this;
  }

  complete() {
    if (!this.isActive()) {
      throw new Error(
        `Cannot complete execution from status "${this.status}"`
      );
    }

    this.status =
      EXECUTION_STATUS.COMPLETED;

    this.goal.transitionTo(Goal.STATUS.COMPLETED);

    this.record(
      'goal.completed',
      this.goal.snapshot()
    );

    this.completedAt =
      new Date().toISOString();

    this.agentState.metrics.completedAt =
      this.completedAt;

    this.transitionAgentTo(
      AgentState.LIFECYCLE.COMPLETED
    );

    this.record(
      'execution.completed',
      this.identity()
    );

    return this;
  }

  fail(error) {
    if (!this.isActive()) {
      throw new Error(
        `Cannot fail execution from status "${this.status}"`
      );
    }

    this.status =
      EXECUTION_STATUS.FAILED;

    if (this.goal.status === Goal.STATUS.RUNNING) {
      this.goal.transitionTo(Goal.STATUS.FAILED);
      this.record(
        'goal.failed',
        this.goal.snapshot()
      );
    }

    this.completedAt =
      new Date().toISOString();

    this.agentState.errors.push({
      code:
        error?.code ||
        'EXECUTION_FAILED',

      message:
        error?.message ||
        String(error || '')
    });

    this.transitionAgentTo(
      AgentState.LIFECYCLE.FAILED
    );

    this.record(
      'execution.failed',
      {
        code:
          error?.code ||
          'EXECUTION_FAILED',

        message:
          error?.message ||
          String(error || '')
      }
    );

    return this;
  }

  cancel(
    reason = 'Execution cancelled'
  ) {
    if (!this.isActive()) {
      throw new Error(
        `Cannot cancel execution from status "${this.status}"`
      );
    }

    this.status =
      EXECUTION_STATUS.CANCELLED;

    this.completedAt =
      new Date().toISOString();

    this.transitionAgentTo(
      AgentState.LIFECYCLE.CANCELLED
    );

    this.record(
      'execution.cancelled',
      {
        reason
      }
    );

    return this;
  }

  record(
    type,
    data = {}
  ) {
    if (
      !type ||
      typeof type !== 'string'
    ) {
      throw new TypeError(
        'event type is required'
      );
    }

    this.events.push({
      id:
        crypto.randomUUID(),

      executionId:
        this.executionId,

      type,

      timestamp:
        new Date().toISOString(),

      data
    });

    return this;
  }

  static restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('snapshot must be an object');
    }

    if (!snapshot.executionId) {
      throw new TypeError('snapshot.executionId is required');
    }

    if (!snapshot.requestId) {
      throw new TypeError('snapshot.requestId is required');
    }

    if (!snapshot.goalId) {
      throw new TypeError('snapshot.goalId is required');
    }

    if (snapshot.input === undefined || snapshot.input === null) {
      throw new TypeError('snapshot.input is required');
    }

    const context = new ExecutionContext({
      requestId: snapshot.requestId,
      input: snapshot.input,
      executionId: snapshot.executionId,
      goalId: snapshot.goalId,
      parentExecutionId: snapshot.parentExecutionId || null,
      tenantId: snapshot.tenantId || snapshot.metadata?.tenantId || null,
      userId: snapshot.userId || snapshot.metadata?.userId || null,
      workspaceId: snapshot.workspaceId || snapshot.metadata?.workspaceId || null,
      metadata:
        snapshot.metadata && typeof snapshot.metadata === 'object'
          ? snapshot.metadata
          : {}
    });

    context.executionVersion =
      Number(snapshot.executionVersion || 1);

    if (snapshot.goal && typeof snapshot.goal === 'object') {
      context.goal = new Goal({
        id: snapshot.goal.id,
        input: snapshot.goal.input,
        executionId: snapshot.goal.executionId || context.executionId,
        tenantId: snapshot.goal.tenantId || context.tenantId,
        userId: snapshot.goal.userId || context.userId,
        workspaceId: snapshot.goal.workspaceId || context.workspaceId,
        metadata: snapshot.goal.metadata || {}
      });
      context.goal.status = snapshot.goal.status || Goal.STATUS.CREATED;
      context.goal.createdAt = snapshot.goal.createdAt || context.goal.createdAt;
      context.goal.startedAt = snapshot.goal.startedAt || null;
      context.goal.completedAt = snapshot.goal.completedAt || null;
    }

    context.status =
      snapshot.status || EXECUTION_STATUS.CREATED;

    context.startedAt =
      snapshot.startedAt || null;

    context.completedAt =
      snapshot.completedAt || null;

    context.plan =
      snapshot.plan || null;

    context.tool =
      snapshot.tool || null;

    context.result =
      snapshot.result ?? null;

    context.currentStep =
      snapshot.currentStep ?? 0;

    context.steps =
      Array.isArray(snapshot.steps)
        ? snapshot.steps.map(step => ({ ...step }))
        : [];

    context.observations =
      Array.isArray(snapshot.observations)
        ? snapshot.observations.map(observation => ({ ...observation }))
        : [];

    context.events =
      Array.isArray(snapshot.events)
        ? snapshot.events.map(event => ({ ...event }))
        : [];

    const persistedAgentState =
      snapshot.agentState &&
      typeof snapshot.agentState === 'object'
        ? snapshot.agentState
        : {};

    const agentState =
      new AgentState({
        agentId:
          persistedAgentState.agentId || 'default-agent',
        goalId:
          persistedAgentState.goalId || context.goalId
      });

    agentState.executionId =
      context.executionId;

    agentState.lifecycle =
      snapshot.agentLifecycle ||
      persistedAgentState.lifecycle ||
      AgentState.LIFECYCLE.CREATED;

    agentState.currentPlan =
      persistedAgentState.currentPlan ??
      context.plan;

    agentState.currentStep =
      persistedAgentState.currentStep ??
      context.currentStep;

    agentState.observations =
      Array.isArray(persistedAgentState.observations)
        ? persistedAgentState.observations.map(observation => ({ ...observation }))
        : context.observations.map(observation => ({ ...observation }));

    agentState.decisions =
      Array.isArray(persistedAgentState.decisions)
        ? persistedAgentState.decisions.map(decision => ({ ...decision }))
        : [];

    agentState.errors =
      Array.isArray(persistedAgentState.errors)
        ? persistedAgentState.errors.map(error => ({ ...error }))
        : [];

    agentState.metrics =
      persistedAgentState.metrics &&
      typeof persistedAgentState.metrics === 'object'
        ? { ...persistedAgentState.metrics }
        : {};

    agentState.createdAt =
      persistedAgentState.createdAt ||
      agentState.createdAt;

    agentState.updatedAt =
      persistedAgentState.updatedAt ||
      agentState.updatedAt;

    context.agentState =
      agentState;

    context.agentStateMachine =
      new AgentStateMachine(agentState);

    return context;
  }

  snapshot() {
    return {
      executionId:
        this.executionId,

      requestId:
        this.requestId,

      goalId:
        this.goalId,

      parentExecutionId:
        this.parentExecutionId,

      tenantId: this.tenantId,
      userId: this.userId,
      workspaceId: this.workspaceId,

      executionVersion:
        this.executionVersion,

      status:
        this.status,

      agentLifecycle:
        this.getAgentLifecycle(),

      startedAt:
        this.startedAt,

      completedAt:
        this.completedAt,

      input:
        this.input,

      metadata: {
        ...this.metadata
      },

      plan:
        this.plan,

      tool:
        this.tool,

      result:
        this.result,

      currentStep:
        this.currentStep,

      steps:
        this.steps,

      observations:
        this.observations,

      goal:
        this.goal.snapshot(),

      agentState:
        this.agentState.toJSON(),

      events:
        this.events
    };
  }
}

ExecutionContext.STATUS =
  EXECUTION_STATUS;

ExecutionContext.AGENT_LIFECYCLE =
  AgentState.LIFECYCLE;

module.exports =
  ExecutionContext;
