'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

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
const JsonPersistence = require('../../src/infrastructure/persistence/json/json-persistence');
const AgentService = require('../../src/application/agent/agent.service');
const ApprovalService = require('../../src/core/agent/approval/approval-service');
const OwnerAuthService = require('../../src/core/security/owner-auth-service');
const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');
const createServer = require('../../src/interfaces/http/server');
const WorkspacePolicy = require('../../src/core/agent/project-builder/workspace/workspace-policy');
const CommandRunner = require('../../src/core/agent/project-builder/workspace/command-runner');

const TENANT = 'tenant-http-approval-restart';

async function sandboxAvailable(root) {
  const policy = new WorkspacePolicy({
    allowedRoot: root,
    allowCommands: true,
    allowedCommands: ['node'],
    timeoutMs: 5000
  });
  const result = await new CommandRunner({ policy }).run('node', { args: ['--version'] });
  return !(result.code !== 0 && /Failed RTM_NEWADDR|Operation not permitted/.test(result.stderr || ''));
}

function createRuntime(root, persistence, ownerAuth) {
  const registry = new AgentRegistry();
  registerDefaultAgents(registry);
  const tools = new ToolRegistry();
  for (const tool of createProjectTools({
    projectRoot: root,
    policy: { allowCommands: true, allowedCommands: ['node'] }
  })) tools.register(tool);

  const orchestrator = new AgentOrchestrator({
    planner: new PlannerService(),
    planValidator: new PlanValidator({ maxSteps: 5, toolRegistry: tools }),
    replanner: new Replanner({ maxReplans: 1 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });
  const approvals = new ApprovalService({
    repository: persistence.approvals,
    tenantId: TENANT
  });
  const authorization = new AuthorizationService({
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
    toolRegistry: tools,
    agentOrchestrator: orchestrator,
    authorizationService: authorization,
    approvalService: approvals,
    persistence,
    tenantId: TENANT,
    agentRegistry: registry,
    approvalDecisionAuthorizer: ({ actorId }) => ownerAuth?.isActiveSession(actorId) === true
  });
}

async function startServer(runtime, ownerAuth) {
  const server = createServer({
    memoryRoutes: { home() {}, add() {}, delete() {} },
    agentRoutes: createAgentRoutes(new AgentService(runtime)),
    ownerAuth
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

async function stopServer(server) {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('owner HTTP decision resumes the same high-risk mission after runtime restart using durable approval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-http-approval-restart-'));
  let runtime;
  let server;
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENT.md'), '# HTTP approval restart fixture\n');
    fs.writeFileSync(path.join(root, 'test', 'smoke.test.js'),
      "const test = require('node:test'); const assert = require('node:assert/strict'); test('smoke', () => assert.equal(1, 1));\n");
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"http-approval-restart"}\n');

    if (!await sandboxAvailable(root)) {
      t.skip('host cannot create the OS sandbox network namespace; high-risk execution must fail closed');
      return;
    }

    const persistenceRoot = path.join(root, '.orient-state');
    let persistence = new JsonPersistence({ rootDir: persistenceRoot });
    const ownerAuth = new OwnerAuthService({ password: 'owner-approval-restart-test-secret-2026' });
    runtime = createRuntime(root, persistence, ownerAuth);
    ({ server } = await startServer(runtime, ownerAuth));
    let origin = 'http://127.0.0.1:' + server.address().port;

    const login = await fetch(origin + '/owner/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: origin },
      body: JSON.stringify({ password: 'owner-approval-restart-test-secret-2026' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const loginBody = await login.json();
    assert.equal(typeof loginBody.csrfToken, 'string');

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
    assert.ok(challenge.approvalId, 'runtime must persist the approval challenge before returning');

    const csrfRejected = await fetch(origin + '/owner/approvals/' + encodeURIComponent(challenge.approvalId) + '/decision', {
      method: 'POST',
      headers: {
        cookie: login.headers.get('set-cookie').split(';')[0],
        origin,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        executionId: challenge.executionId,
        decision: 'approved'
      })
    });
    assert.equal(csrfRejected.status, 403, 'approval decisions must reject missing CSRF proof');
    assert.equal((await csrfRejected.json()).code, 'OWNER_CSRF_REJECTED');

    const decision = await fetch(origin + '/owner/approvals/' + encodeURIComponent(challenge.approvalId) + '/decision', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: origin,
        Cookie: cookie,
        'x-orient-csrf': loginBody.csrfToken
      },
      body: JSON.stringify({
        executionId: challenge.executionId,
        decision: 'approved',
        actorId: 'public:forged-actor'
      })
    });
    assert.equal(decision.status, 200, await decision.text());

    const storedDecision = await runtime.approvalService.getApprovedForExecution({
      approvalId: challenge.approvalId,
      executionId: challenge.executionId,
      tenantId: TENANT
    });
    assert.equal(storedDecision.decision.actorId, ownerAuth.authenticate(cookie.split('=')[1]).sessionId);

    // Simulate a process boundary: close the first listener/runtime and reopen
    // all JSON repositories from disk. The owner session remains in the auth
    // service, while execution/approval state must be recovered from storage.
    await stopServer(server);
    server = null;
    await runtime.shutdown({ cancelQueued: false });
    runtime = null;
    persistence = new JsonPersistence({ rootDir: persistenceRoot });
    runtime = createRuntime(root, persistence, ownerAuth);
    ({ server, origin } = await startServer(runtime, ownerAuth));

    const resume = await fetch(origin + '/owner/executions/' + encodeURIComponent(challenge.executionId) + '/resume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: origin,
        Cookie: cookie,
        'x-orient-csrf': loginBody.csrfToken
      },
      body: JSON.stringify({ approval: { approvalId: challenge.approvalId } })
    });
    assert.equal(resume.status, 200);
    const resumed = await resume.json();
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.execution.status, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test, 'node --test');

    const persisted = await persistence.approvals.findById(challenge.approvalId, { tenantId: TENANT });
    assert.ok(persisted, 'approval record must remain durable after the resume consumes it');
    assert.equal(persisted.decision.status, 'approved');
    assert.equal(persisted.decision.actorId, ownerAuth.authenticate(cookie.split('=')[1]).sessionId);

    const replay = await fetch(origin + '/owner/executions/' + encodeURIComponent(challenge.executionId) + '/resume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: origin,
        Cookie: cookie,
        'x-orient-csrf': loginBody.csrfToken
      },
      body: JSON.stringify({ approval: { approvalId: challenge.approvalId } })
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.resumed, false);
    assert.equal(replayed.reason, 'execution_already_terminal');
  } finally {
    await stopServer(server);
    if (runtime) await runtime.shutdown({ cancelQueued: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
