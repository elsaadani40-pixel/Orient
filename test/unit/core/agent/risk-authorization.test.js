const test = require('node:test');
const assert = require('node:assert/strict');

const CapabilityMapper = require('../../../../src/core/agent/capability/capability-mapper');
const PolicyEngine = require('../../../../src/core/agent/policy/policy-engine');
const AuthorizationService = require('../../../../src/core/agent/authorization/authorization-service');
const ApprovalService = require('../../../../src/core/agent/approval/approval-service');

test('high risk capability requires matching single use approval', async () => {
  const mapper = new CapabilityMapper({
    mappings: { 'danger.write': 'external.write' }
  });

  const policy = new PolicyEngine({
    capabilities: ['external.write'],
    riskByCapability: { 'external.write': 'high' }
  });

  const approvals = new ApprovalService({ decisionAuthorizer: async () => true });
  const auth = new AuthorizationService({
    capabilityMapper: mapper,
    capabilityPolicy: policy,
    approvalService: approvals
  });

  const denied = await auth.authorize('danger.write', {
    executionId: 'exec-1',
    step: 1,
    scope: { planRevision: 1 }
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'APPROVAL_REQUIRED');

  const approval = await approvals.issue({
    executionId: 'exec-1',
    step: 1,
    tool: 'danger.write',
    capability: 'external.write',
    scope: { planRevision: 1 }
  });

  await approvals.decide({ approvalId: approval.approvalId, executionId: 'exec-1', decision: 'approved', actorId: 'owner-test' });

  const allowed = await auth.authorize('danger.write', {
    executionId: 'exec-1',
    step: 1,
    approval,
    scope: { planRevision: 1 }
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.risk, 'high');

  assert.equal(await approvals.consume(approval.approvalId), true);

  const replay = await auth.authorize('danger.write', {
    executionId: 'exec-1',
    step: 1,
    approval,
    scope: { planRevision: 1 }
  });
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, 'APPROVAL_ALREADY_USED');
});


test('authorization cannot mint tool execution authority without the agent boundary', async () => {
  const CapabilityRegistry = require('../../../../src/core/agent/capability/capability-registry');
  const Capability = require('../../../../src/core/agent/capability/capability');
  const CapabilityGovernance = require('../../../../src/core/agent/capability/capability-governance');
  const AgentRegistry = require('../../../../src/core/agent/boundary/agent-registry');
  const { AgentDefinition } = require('../../../../src/core/agent/boundary/agent-definition');

  const registry = new CapabilityRegistry();
  registry.register(new Capability({ name: 'external.write', description: 'write', risk: 'high' }));

  const mapper = new CapabilityMapper({ mappings: { 'danger.write': 'external.write' } });
  const agents = new AgentRegistry();
  agents.register(new AgentDefinition({ id: 'safe', capabilities: ['tool:danger.write'] }));
  agents.register(new AgentDefinition({ id: 'reader', capabilities: [] }));

  const governance = new CapabilityGovernance({
    capabilityMapper: mapper,
    capabilityRegistry: registry,
    agentRegistry: agents
  });

  const policy = new PolicyEngine({
    capabilities: ['external.write'],
    riskByCapability: { 'external.write': 'high' }
  });

  const auth = new AuthorizationService({
    capabilityMapper: mapper,
    capabilityPolicy: policy,
    capabilityGovernance: governance
  });

  const denied = await auth.authorize('danger.write', { agentId: 'reader' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'AGENT_TOOL_CAPABILITY_FORBIDDEN');

  const missingIdentity = await auth.authorize('danger.write');
  assert.equal(missingIdentity.allowed, false);
  assert.equal(missingIdentity.reason, 'AGENT_ID_REQUIRED');
});
