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
const ApprovalService = require('../../src/core/agent/approval/approval-service');
const JsonPersistence = require('../../src/infrastructure/persistence/json/json-persistence');
const AgentService = require('../../src/application/agent/agent.service');
const OwnerAuthService = require('../../src/core/security/owner-auth-service');
const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');
const createServer = require('../../src/interfaces/http/server');

test('authenticated dashboard request completes a harmless mission through the real runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-runtime-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENT.md'), '# Owner runtime fixture\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"owner-runtime-fixture"}\n');

  const persistence = new JsonPersistence({ rootDir: path.join(root, '.orient-state') });
  const agentRegistry = new AgentRegistry();
  registerDefaultAgents(agentRegistry);

  const toolRegistry = new ToolRegistry();
  for (const tool of createProjectTools({ projectRoot: root })) toolRegistry.register(tool);

  const agentOrchestrator = new AgentOrchestrator({
    planner: new PlannerService(),
    planValidator: new PlanValidator({ maxSteps: 5, toolRegistry }),
    replanner: new Replanner({ maxReplans: 1 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });

  const approvalService = new ApprovalService({ tenantId: 'tenant-owner-runtime' });
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
    approvalService
  });

  const runtime = new OrientRuntime({
    toolRegistry,
    agentOrchestrator,
    authorizationService,
    approvalService,
    persistence,
    tenantId: 'tenant-owner-runtime',
    agentRegistry
  });
  const ownerAuth = new OwnerAuthService({ password: 'owner-runtime-test-secret-2026' });
  const server = createServer({
    memoryRoutes: { home() {}, add() {}, delete() {} },
    agentRoutes: createAgentRoutes(new AgentService(runtime)),
    ownerAuth
  });

  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await runtime.shutdown({ cancelQueued: false });
    fs.rmSync(root, { recursive: true, force: true });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const denied = await fetch(origin + '/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ input: 'must not execute without owner login' })
  });
  assert.equal(denied.status, 401);

  const login = await fetch(origin + '/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: 'owner-runtime-test-secret-2026' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const dashboard = await fetch(origin + '/dashboard', { headers: { Cookie: cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /fetch\('\/agent'/);

  const response = await fetch(origin + '/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ input: 'افحص المشروع' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.type, 'tool_result');
  assert.equal(result.result.status, 'healthy');
  assert.equal(result.result.audit.modificationAllowed, false);
  assert.equal(result.result.audit.commandExecutionAllowed, false);
  assert.equal(result.execution.status, 'completed');
  assert.ok(result.execution.executionId);

  const statusResponse = await fetch(origin + '/executions/' + encodeURIComponent(result.execution.executionId), {
    headers: { Cookie: cookie }
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.executionId, result.execution.executionId);
  assert.equal(status.status, 'completed');
  assert.equal(status.tenantId, 'tenant-owner-runtime');
});
