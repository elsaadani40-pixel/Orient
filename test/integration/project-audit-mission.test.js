const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AgentRegistry = require('../../src/core/agent/boundary/agent-registry');
const { registerDefaultAgents } = require('../../src/core/agent/catalog/default-agents');
const PlannerService = require('../../src/application/planner/planner.service');
const PlanValidator = require('../../src/core/planning/validation/plan-validator');
const Replanner = require('../../src/core/planning/replanning/replanner');
const DecisionEngine = require('../../src/core/agent/decision/decision-engine');
const RecoveryEngine = require('../../src/core/agent/recovery/recovery-engine');
const AgentOrchestrator = require('../../src/core/agent/orchestrator/agent-orchestrator');
const ToolRegistry = require('../../src/core/tools/tool.registry');
const OrientRuntime = require('../../src/core/runtime/orient-runtime');
const createProjectTools = require('../../src/application/tools/project.tools');
const CapabilityMapper = require('../../src/core/agent/capability/capability-mapper');
const PolicyEngine = require('../../src/core/agent/policy/policy-engine');
const AuthorizationService = require('../../src/core/agent/authorization/authorization-service');
const ApprovalService = require('../../src/core/agent/approval/approval-service');
const JsonPersistence = require('../../src/infrastructure/persistence/json/json-persistence');
const WorkspacePolicy = require('../../src/core/agent/project-builder/workspace/workspace-policy');
const CommandRunner = require('../../src/core/agent/project-builder/workspace/command-runner');

async function skipIfOsSandboxUnavailable(t, root) {
  const policy = new WorkspacePolicy({
    allowedRoot: root,
    allowCommands: true,
    allowedCommands: ['node'],
    timeoutMs: 5000
  });
  const result = await new CommandRunner({ policy }).run('node', {
    args: ['--version']
  });
  if (result.code !== 0 && /Failed RTM_NEWADDR|Operation not permitted/.test(result.stderr || '')) {
    t.skip('host runner cannot create the network namespace required by the OS sandbox; execution fails closed');
    return true;
  }
  return false;
}

function createRuntime(root, { secure = false, approvalService = null } = {}) {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  if (!fs.existsSync(path.join(root, 'AGENT.md'))) fs.writeFileSync(path.join(root, 'AGENT.md'), '# mission fixture\n');
  const persistence = new JsonPersistence({ rootDir: path.join(root, '.orient-state') });
  const registry = new AgentRegistry(); registerDefaultAgents(registry);
  const toolRegistry = new ToolRegistry(); for (const tool of createProjectTools({ projectRoot: root })) toolRegistry.register(tool);
  const orchestrator = new AgentOrchestrator({ planner: new PlannerService(), planValidator: new PlanValidator({ maxSteps: 5, toolRegistry }), replanner: new Replanner({ maxReplans: 1 }), decisionEngine: new DecisionEngine(), recoveryEngine: new RecoveryEngine() });
  if (!secure) return new OrientRuntime({ toolRegistry, agentOrchestrator: orchestrator, persistence, tenantId: 'tenant-mission', agentRegistry: registry });
  const approvals = approvalService || new ApprovalService({ tenantId: 'tenant-mission' });
  const authorizationService = new AuthorizationService({
    capabilityMapper: new CapabilityMapper({
      mappings: {
        'project.audit': 'workspace.read',
        'project.propose_changes': 'workspace.read',
        'project.execute_change': 'workspace.write'
      }
    }),
    capabilityPolicy: new PolicyEngine({
      capabilities: ['workspace.read', 'workspace.write'],
      riskByCapability: { 'workspace.read': 'low', 'workspace.write': 'high' }
    }),
    approvalService: approvals
  });
  return new OrientRuntime({
    toolRegistry,
    agentOrchestrator: orchestrator,
    authorizationService,
    approvalService: approvals,
    persistence,
    tenantId: 'tenant-mission',
    agentRegistry: registry
  });
}
test('project audit mission completes through canonical runtime without write or command access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-')); fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test')); fs.writeFileSync(path.join(root, 'AGENT.md'), '# test'); fs.writeFileSync(path.join(root, 'package.json'), '{"name":"mission-fixture"}');
  const runtime = createRuntime(root); const result = await runtime.execute('افحص المشروع');
  assert.equal(result.type, 'tool_result'); assert.equal(result.result.status, 'healthy'); assert.equal(result.result.score, 100); assert.equal(result.result.recommendation, 'safe-to-proceed'); assert.equal(result.result.definitionOfDone.satisfied, true); assert.equal(result.result.audit.modificationAllowed, false); assert.equal(result.result.audit.commandExecutionAllowed, false); assert.equal(result.execution.status, 'completed');
  runtime.shutdown({ cancelQueued: false }); fs.rmSync(root, { recursive: true, force: true });
});
test('project change-proposal mission finds a real issue and never executes the proposal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-proposal-')); fs.mkdirSync(path.join(root, 'test')); const manifestPath = path.join(root, 'package.json'); const original = '{"name":"proposal-fixture"}\n'; fs.writeFileSync(manifestPath, original);
  const runtime = createRuntime(root); const result = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا');
  assert.equal(result.type, 'tool_result'); assert.equal(result.result.status, 'actionable'); assert.equal(result.result.execution.allowed, false); assert.equal(result.result.execution.performed, false); assert.equal(result.result.findings[0].id, 'missing-test-script'); assert.equal(result.result.proposals.length, 1); assert.equal(result.result.proposals[0].action, 'update'); assert.equal(result.result.proposals[0].path, 'package.json'); assert.match(result.result.proposals[0].content, /"test": "node --test"/); assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);
  runtime.shutdown({ cancelQueued: false }); fs.rmSync(root, { recursive: true, force: true });
});

test('project change mission executes the proposal in the bounded workspace and verifies it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-execution-'));
  if (await skipIfOsSandboxUnavailable(t, root)) { fs.rmSync(root, { recursive: true, force: true }); return; }
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'smoke.test.js'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('smoke', () => assert.equal(1, 1));\n");
  const manifestPath = path.join(root, 'package.json');
  const original = '{"name":"execution-fixture"}\n';
  fs.writeFileSync(manifestPath, original);

  const runtime = createRuntime(root);
  const result = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا ثم نفذ التغيير وتحقق منه');

  assert.equal(result.type, 'tool_result');
  assert.equal(result.result.status, 'verified', JSON.stringify(result.result));
  assert.equal(result.result.modification.applied, true);
  assert.equal(result.result.verification.status, 'passed');
  assert.equal(result.result.verification.definitionOfDoneSatisfied, true);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.test, 'node --test');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('verification failure rolls the project back to its pre-execution state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-rollback-'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'failing.test.js'), "const test = require('node:test'); test('fails', () => { throw new Error('intentional'); });\n");
  const manifestPath = path.join(root, 'package.json');
  const original = '{"name":"rollback-fixture"}\n';
  fs.writeFileSync(manifestPath, original);

  const runtime = createRuntime(root);
  const result = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا ثم نفذ التغيير وتحقق منه');

  assert.equal(result.type, 'tool_result');
  assert.equal(result.result.status, 'failed', JSON.stringify(result.result));
  assert.equal(result.result.rollback.rolledBack, true);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('project change precondition blocks stale proposals after external mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-precondition-'));
  fs.mkdirSync(path.join(root, 'test'));
  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"precondition-fixture"}\n');

  const runtime = createRuntime(root);
  const proposal = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا');
  assert.equal(proposal.result.proposals.length, 1);

  fs.writeFileSync(manifestPath, '{"name":"externally-modified"}\n');

  const executeTool = runtime.toolRegistry.get('project.execute_change');
  const staleExecution = await executeTool.execute(proposal.result);
  assert.equal(staleExecution.status, 'failed');
  assert.equal(
    staleExecution.error?.code,
    'CHANGE_PRECONDITION_FAILED'
  );
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{"name":"externally-modified"}\n');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('project change reconciliation recognizes an already-applied post-state without reapplying it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-reconcile-'));
  fs.mkdirSync(path.join(root, 'test'));
  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"reconcile-fixture"}\n');

  const runtime = createRuntime(root);
  const proposal = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا');
  const tool = runtime.toolRegistry.get('project.execute_change');
  const reconciledInput = proposal.result;

  fs.writeFileSync(manifestPath, proposal.result.proposals[0].content);
  const reconciliation = await tool.reconcile(reconciledInput, {
    operationId: 'recovery-test',
    executionId: proposal.requestId,
    step: 2,
    planRevision: 1,
    tool: 'project.execute_change'
  });

  assert.equal(reconciliation.status, 'completed');
  assert.equal(reconciliation.result.status, 'verified');
  assert.equal(reconciliation.result.reconciled, true);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), proposal.result.proposals[0].content);

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('project change reconciliation refuses an unexpected external state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-reconcile-conflict-'));
  fs.mkdirSync(path.join(root, 'test'));
  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"reconcile-conflict"}\n');

  const runtime = createRuntime(root);
  const proposal = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا');
  const tool = runtime.toolRegistry.get('project.execute_change');

  fs.writeFileSync(manifestPath, '{"name":"unexpected-external-change"}\n');
  const reconciliation = await tool.reconcile(proposal.result, {
    operationId: 'recovery-conflict-test',
    executionId: proposal.requestId,
    step: 2,
    planRevision: 1,
    tool: 'project.execute_change'
  });

  assert.equal(reconciliation.status, 'conflict');
  assert.equal(reconciliation.reason, 'external_state_does_not_match_expected_post_state');
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{"name":"unexpected-external-change"}\n');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('high-risk project execution requires a real approval, then executes through the full canonical path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-high-risk-e2e-'));
  if (await skipIfOsSandboxUnavailable(t, root)) { fs.rmSync(root, { recursive: true, force: true }); return; }
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'smoke.test.js'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('smoke', () => assert.equal(1, 1));\n");
  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"high-risk-fixture"}\n');

  const approvals = new ApprovalService({ tenantId: 'tenant-mission' });
  const runtime = createRuntime(root, { secure: true, approvalService: approvals });

  let challenge;
  await assert.rejects(
    runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا ثم نفذ التغيير وتحقق منه'),
    error => {
      assert.equal(error.code, 'APPROVAL_REQUIRED');
      challenge = error.executionContext;
      return true;
    }
  );

  assert.ok(challenge.executionId);
  assert.equal(challenge.tool, 'project.execute_change');
  assert.equal(challenge.capability, 'workspace.write');
  assert.equal(challenge.agentId, 'PROJECT_BUILDER_AGENT');
  assert.match(challenge.operationId, /^[a-f0-9]{64}$/);

  const approval = await approvals.issue({
    executionId: challenge.executionId,
    step: challenge.step,
    tool: challenge.tool,
    capability: challenge.capability,
    planRevision: challenge.planRevision,
    tenantId: challenge.tenantId,
    agentId: challenge.agentId,
    operationId: challenge.operationId,
    scope: { planRevision: challenge.planRevision }
  });
  approvals.decisionAuthorizer = async () => true;
  await approvals.decide({
    approvalId: approval.approvalId,
    executionId: challenge.executionId,
    decision: 'approved',
    actorId: 'test-owner',
    tenantId: challenge.tenantId
  });

  const resumed = await runtime.resume(challenge.executionId, { approval });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.result.status, 'verified');
  assert.equal(resumed.result.verification.status, 'passed');
  assert.equal(resumed.result.verification.definitionOfDoneSatisfied, true);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.test, 'node --test');

  const replay = await runtime.resume(challenge.executionId, { approval });
  assert.equal(replay.resumed, false);
  assert.equal(replay.reason, 'execution_already_terminal');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});
