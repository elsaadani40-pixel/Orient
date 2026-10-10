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

function createRuntime(root, { approvalService = null, persistence: persisted = null } = {}) {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  if (!fs.existsSync(path.join(root, 'AGENT.md'))) fs.writeFileSync(path.join(root, 'AGENT.md'), '# mission fixture\n');
  const persistence = persisted || new JsonPersistence({ rootDir: path.join(root, '.orient-state') });
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

  const approvals = approvalService || new ApprovalService({ tenantId: 'tenant-mission-8', repository: persistence.approvals });
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

  assert.equal(typeof challenge.approvalId, 'string', 'runtime must persist and return the approval challenge identity');
  const approval = approvals.repository?.findById
    ? await approvals.repository.findById(challenge.approvalId, { tenantId: challenge.tenantId })
    : approvals.approvals.get(challenge.approvalId);
  assert.ok(approval, 'the approval ID returned by the runtime must resolve to its durable challenge record');
  assert.equal(approval.executionId, challenge.executionId);
  assert.equal(approval.operationId || approval.metadata?.operationId, challenge.operationId);

  if (typeof approvals.decisionAuthorizer !== 'function') {
    approvals.decisionAuthorizer = async () => true;
  }
  await approvals.decide({
    approvalId: approval.approvalId,
    executionId: challenge.executionId,
    decision: 'approved',
    actorId: 'test-owner',
    tenantId: challenge.tenantId
  });

  return { challenge, approval };
}

test('high-risk verification failure rolls back after a real approval and cannot be replayed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-8-rollback-'));
  if (await skipIfOsSandboxUnavailable(t, root)) { fs.rmSync(root, { recursive: true, force: true }); return; }
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

test('high-risk crash after side effect does not execute the side effect twice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-8-crash-'));
  if (await skipIfOsSandboxUnavailable(t, root)) { fs.rmSync(root, { recursive: true, force: true }); return; }
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(
    path.join(root, 'test', 'smoke.test.js'),
    "const test = require('node:test'); const assert = require('node:assert/strict'); test('smoke', () => assert.equal(1, 1));\n"
  );

  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"mission-8-crash"}\n');

  const persistenceRoot = path.join(root, '.orient-state');
  const persistence = new JsonPersistence({ rootDir: persistenceRoot });
  const approvals = new ApprovalService({
    tenantId: 'tenant-mission-8',
    repository: persistence.approvals,
    decisionAuthorizer: async () => true
  });
  let runtime = createRuntime(root, { approvalService: approvals, persistence });
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

  // A real process death cannot run the normal recovery handler. Make the
  // injected crash escape that handler so the durable state remains at the
  // last committed checkpoint, exactly as it would after abrupt termination.
  runtime.executionRecoveryCoordinator.fail = async () => {
    throw Object.assign(new Error('simulated process terminated before recovery'), {
      code: 'SIMULATED_PROCESS_CRASH'
    });
  };

  await assert.rejects(
    runtime.resume(challenge.executionId, { approval }),
    error => error && error.code === 'SIMULATED_PROCESS_CRASH'
  );

  assert.equal(crashInjected, true);
  assert.equal(executionCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.test, 'node --test');

  // Simulate a real process restart: discard the runtime, reopen every JSON
  // repository from disk, and resume without passing the original approval.
  runtime.shutdown({ cancelQueued: false });

  // Abrupt process death leaves its lease behind until TTL expiry. Advance the
  // persisted lease clock in the fixture instead of sleeping for 30 seconds.
  const checkpointPath = path.join(persistenceRoot, 'checkpoints.json');
  const checkpointRecords = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const persistedCheckpoint = checkpointRecords[challenge.executionId];
  assert.ok(persistedCheckpoint?.resumeLease, 'crash should leave the old resume lease durable');
  persistedCheckpoint.resumeLease.expiresAtMs = Date.now() - 1;
  persistedCheckpoint.resumeLease.expiresAt = new Date(Date.now() - 1).toISOString();
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpointRecords, null, 2) + '\n');

  const restartedPersistence = new JsonPersistence({ rootDir: persistenceRoot });
  runtime = createRuntime(root, { persistence: restartedPersistence });

  const restartedExecute = runtime.toolRegistry.execute.bind(runtime.toolRegistry);
  runtime.toolRegistry.execute = async (name, input, context) => {
    if (name === 'project.execute_change') executionCount += 1;
    return restartedExecute(name, input, context);
  };

  const recovered = await runtime.resume(challenge.executionId);
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.execution.status, 'completed');
  assert.equal(executionCount, 1, 'restart must reuse the durable idempotency result, not repeat the side effect');
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.test, 'node --test');
  assert.ok(
    recovered.execution.events.some(event => event.type === 'idempotency.reused'),
    'recovery should record that it reused the completed idempotency record'
  );

  const terminal = await runtime.resume(challenge.executionId);
  assert.equal(terminal.resumed, false);
  assert.equal(terminal.reason, 'execution_already_terminal');
  assert.equal(executionCount, 1);

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});


test('concurrent resume attempts are serialized by the durable lease', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-8-concurrent-resume-'));
  if (await skipIfOsSandboxUnavailable(t, root)) {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(
    path.join(root, 'test', 'smoke.test.js'),
    "const test = require('node:test'); const assert = require('node:assert/strict'); test('smoke', () => assert.equal(1, 1));\n"
  );
  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, '{"name":"mission-8-concurrent-resume"}\n');

  const persistence = new JsonPersistence({ rootDir: path.join(root, '.orient-state') });
  const approvals = new ApprovalService({ tenantId: 'tenant-mission-8' });
  const runtimeA = createRuntime(root, { approvalService: approvals, persistence });
  const { challenge, approval } = await approveChallenge(runtimeA, approvals, root);
  const runtimeB = createRuntime(root, { approvalService: approvals, persistence });

  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  let releaseRun;
  const runGate = new Promise(resolve => { releaseRun = resolve; });
  let sideEffectCount = 0;
  const originalExecute = runtimeA.toolRegistry.execute.bind(runtimeA.toolRegistry);
  runtimeA.toolRegistry.execute = async (name, input, context) => {
    if (name === 'project.execute_change') {
      signalEntered();
      await runGate;
      sideEffectCount += 1;
    }
    return originalExecute(name, input, context);
  };

  try {
    const firstResume = runtimeA.resume(challenge.executionId, { approval });
    await entered;

    await assert.rejects(
      runtimeB.resume(challenge.executionId, { approval }),
      error => error?.code === 'CHECKPOINT_RESUME_LEASE_HELD'
    );
    assert.equal(sideEffectCount, 0, 'the blocked concurrent attempt must not reach tool execution');

    releaseRun();
    const firstResult = await firstResume;
    assert.equal(firstResult.resumed, true);
    assert.equal(firstResult.execution.status, 'completed');
    assert.equal(sideEffectCount, 1, 'only the lease owner may execute the approved side effect');

    const replay = await runtimeB.resume(challenge.executionId, { approval });
    assert.equal(replay.resumed, false);
    assert.equal(replay.reason, 'execution_already_terminal');
    assert.equal(sideEffectCount, 1);
  } finally {
    releaseRun();
    runtimeA.shutdown({ cancelQueued: false });
    runtimeB.shutdown({ cancelQueued: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
