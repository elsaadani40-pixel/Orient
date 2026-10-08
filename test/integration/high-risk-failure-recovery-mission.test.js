const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function createRuntime(root, { approvalService = null, persistence = null } = {}) {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const persistence = persistence || new JsonPersistence({ rootDir: path.join(root, '.orient-state') });
  const registry = new AgentRegistry();
  registerDefaultAgents(registry);

  const toolRegistry = new ToolRegistry();
  for (const tool of createProjectTools({ projectRoot: root })) {
    toolRegistry.register(tool);
  }

  const orchestrator = new AgentOrchestrator({
    planner: new PlannerService(),
    planValidator: new PlanValidator({ maxSteps: 5, toolRegistry }),
    replanner: new Replanner({ maxReplans: 1 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });

  const approvals = approvalService || new ApprovalService({ tenantId: 'tenant-mission-8' });
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
    tenantId: 'tenant-mission-8',
    agentRegistry: registry
  });
}

async function approveChallenge(runtime, approvals, root) {
  let challenge;
  await assert.rejects(
    runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا ثم نفذ التغيير وتحقق منه'),
    error => {
      assert.equal(error.code, 'APPROVAL_REQUIRED');
      challenge = error.executionContext;
      return true;
    }
  );

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

  return { challenge, approval };
}

test('high-risk verification failure rolls back after a real approval and cannot be replayed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-8-rollback-'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(
    path.join(root, 'test', 'failing.test.js'),
    "const test = require('node:test'); test('intentional failure', () => { throw new Error('intentional'); });\n"
  );

  const manifestPath = path.join(root, 'package.json');
  const original = '{"name":"mission-8-rollback"}\n';
  fs.writeFileSync(manifestPath, original);

  const approvals = new ApprovalService({ tenantId: 'tenant-mission-8' });
  const runtime = createRuntime(root, { approvalService: approvals });
  const { challenge, approval } = await approveChallenge(runtime, approvals, root);

  const resumed = await runtime.resume(challenge.executionId, { approval });

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.result.status, 'failed');
  assert.equal(resumed.result.rollback.rolledBack, true);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);

  const replay = await runtime.resume(challenge.executionId, { approval });
  assert.equal(replay.resumed, false);
  assert.equal(replay.reason, 'execution_already_terminal');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('high-risk crash after side effect does not execute the side effect twice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-8-crash-'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(
    path.join(root, 'test', 'smoke.test.js'),
    "const test = require('node:test'); const assert = require('node:assert/strict'); test('smoke', () => assert.equal(1, 1));\n"
  );

  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"mission-8-crash"}\n');

  const approvals = new ApprovalService({ tenantId: 'tenant-mission-8' });
  const runtime = createRuntime(root, { approvalService: approvals });
  const { challenge, approval } = await approveChallenge(runtime, approvals, root);

  const originalExecute = runtime.toolRegistry.execute.bind(runtime.toolRegistry);
  let executionCount = 0;
  runtime.toolRegistry.execute = async (name, input, context) => {
    if (name === 'project.execute_change') executionCount += 1;
    return originalExecute(name, input, context);
  };

  const originalCheckpoint = runtime.checkpoint.bind(runtime);
  let crashInjected = false;
  runtime.checkpoint = async (context, mode, reason) => {
    if (!crashInjected && reason === 'step_completed:plan-1:step-2') {
      crashInjected = true;
      throw Object.assign(new Error('simulated process crash after side effect'), {
        code: 'SIMULATED_PROCESS_CRASH'
      });
    }
    return originalCheckpoint(context, mode, reason);
  };

  await assert.rejects(
    runtime.resume(challenge.executionId, { approval }),
    error => error && error.code === 'SIMULATED_PROCESS_CRASH'
  );

  assert.equal(crashInjected, true);
  assert.equal(executionCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.test, 'node --test');

  const terminal = await runtime.resume(challenge.executionId);
  assert.equal(terminal.resumed, false);
  assert.equal(terminal.reason, 'execution_already_terminal');
  assert.equal(executionCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.test, 'node --test');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});
