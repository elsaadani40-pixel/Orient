const test = require('node:test');
const assert = require('node:assert/strict');

const AgentLoop = require('../../../../src/core/execution/agent-loop');

test('AgentLoop sends canonical agent and operation identity into approval authorization', async () => {
  const authorizationContexts = [];
  const registry = {
    requireAuthorization() {},
    has(tool) { return tool === 'danger.write'; },
    get() { return { name: 'danger.write' }; },
    authorizeExecutionContext() {},
    async execute() { return { status: 'ok' }; }
  };

  const context = {
    executionId: 'exec-loop-binding',
    requestId: 'request-1',
    tenantId: 'tenant-a',
    input: { target: 'project' },
    status: 'RUNNING',
    currentStep: 0,
    steps: [],
    observations: [],
    record() {},
    setTool() {},
    startStep({ step, tool, planRevision, operationId }) {
      this.steps.push({ step, tool, planRevision, operationId, status: 'running' });
    },
    completeStep({ step, tool, result, planRevision }) {
      const current = this.steps.find(item => item.step === step);
      Object.assign(current, { tool, result, planRevision, status: 'completed' });
    },
    failStep() {},
    addObservation(value) { this.observations.push(value); }
  };

  const authorizationService = {
    approvalService: null,
    async assertAuthorized(tool, request) {
      authorizationContexts.push({ tool, ...request });
      return {
        allowed: true,
        tool,
        capability: 'external.write',
        risk: 'high',
        requiresApproval: false
      };
    }
  };

  const loop = new AgentLoop({
    toolRegistry: registry,
    authorizationService,
    maxSteps: 1
  });

  const result = await loop.run({
    plan: {
      agentId: 'PROJECT_BUILDER_AGENT',
      steps: [{
        step: 1,
        tool: 'danger.write',
        input: { target: 'project' },
        agentId: 'PROJECT_BUILDER_AGENT'
      }]
    },
    context,
    runtimeContext: { tenantId: 'tenant-a' }
  });

  assert.equal(result.status, 'done');
  assert.equal(authorizationContexts.length, 1);
  assert.equal(authorizationContexts[0].agentId, 'PROJECT_BUILDER_AGENT');
  assert.match(authorizationContexts[0].operationId, /^[a-f0-9]{64}$/);
  assert.equal(
    authorizationContexts[0].operationId,
    context.steps[0].operationId
  );
});
