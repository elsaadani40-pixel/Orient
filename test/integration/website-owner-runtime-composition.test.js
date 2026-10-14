'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const OwnerIdentityService = require('../../src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter = require('../../src/core/security/owner-identity-runtime-adapter');
const { createOwnerServer } = require('../../server');
const createServer = require('../../src/interfaces/http/server');
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
const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');

function cookie(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'expected a session cookie');
  return value.split(';')[0];
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}

test('website owner session creates and reads a task through the real Runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-runtime-composition-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENT.md'), '# Runtime test fixture\\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"orient-runtime-test"}\\n');
  const dataDir = path.join(root, '.orient-data');
  const bootstrapPassword = 'temporary-owner-password-9F!x';
  const permanentPassword = 'permanent-owner-password-8Z!';

  const identity = new OwnerIdentityService({ stateFile: path.join(dataDir, 'owner.json'), bootstrapPassword });
  const ownerAuth = new OwnerIdentityRuntimeAdapter({ identity });
  const website = createOwnerServer({ dataDir, identity: ownerAuth, log: () => {} });

  const persistence = new JsonPersistence({ rootDir: path.join(root, '.orient-state') });
  const agentRegistry = new AgentRegistry();
  registerDefaultAgents(agentRegistry);
  const toolRegistry = new ToolRegistry();
  for (const tool of createProjectTools({ projectRoot: root })) toolRegistry.register(tool);
  const approvalService = new ApprovalService({ tenantId: 'website-runtime-test' });
  const authorizationService = new AuthorizationService({
    capabilityMapper: new CapabilityMapper({ mappings: {
      'project.audit': 'workspace.read',
      'project.propose_changes': 'workspace.read',
      'project.execute_change': 'workspace.write'
    } }),
    capabilityPolicy: new PolicyEngine({
      capabilities: ['workspace.read', 'workspace.write'],
      riskByCapability: { 'workspace.read': 'low', 'workspace.write': 'high' }
    }),
    approvalService
  });
  const runtime = new OrientRuntime({
    toolRegistry,
    agentOrchestrator: new AgentOrchestrator({
      planner: new PlannerService(),
      planValidator: new PlanValidator({ maxSteps: 5, toolRegistry }),
      replanner: new Replanner({ maxReplans: 1 }),
      decisionEngine: new DecisionEngine(),
      recoveryEngine: new RecoveryEngine()
    }),
    authorizationService,
    approvalService,
    persistence,
    tenantId: 'website-runtime-test',
    agentRegistry
  });
  const server = createServer({
    memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('home'); } },
    agentRoutes: createAgentRoutes(new AgentService(runtime)),
    ownerAuth,
    websiteHandler: website.handler
  });

  t.after(async () => {
    await close(server);
    await runtime.shutdown({ cancelQueued: false });
    await close(website.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  const login = await fetch(origin + '/api/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'Admin', password: bootstrapPassword })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  let ownerCookie = cookie(login);

  const blocked = await fetch(origin + '/api/v1/tasks', { headers: { Cookie: ownerCookie } });
  assert.equal(blocked.status, 403);

  const rotation = await fetch(origin + '/api/owner/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin, Cookie: ownerCookie, 'X-ORIENT-CSRF': loginBody.csrfToken },
    body: JSON.stringify({ password: permanentPassword, confirmPassword: permanentPassword })
  });
  assert.equal(rotation.status, 200);
  const rotationBody = await rotation.json();
  ownerCookie = cookie(rotation);

  const registration = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'PublicRuntimeTest', password: 'public-test-password-2026!' })
  });
  assert.equal(registration.status, 201);
  const publicDenied = await fetch(origin + '/api/v1/tasks', { headers: { Cookie: cookie(registration) } });
  assert.equal(publicDenied.status, 401);

  const ownerConsole = await fetch(origin + '/owner', { headers: { Cookie: ownerCookie } });
  assert.equal(ownerConsole.status, 200);
  const ownerConsoleHtml = await ownerConsole.text();
  assert.match(ownerConsoleHtml, /id="runtime-status"/);
  assert.match(ownerConsoleHtml, /href="\/workbench"/);

  const workbench = await fetch(origin + '/workbench', { headers: { Cookie: ownerCookie } });
  assert.equal(workbench.status, 200);
  assert.match(await workbench.text(), /مساحة اختبار المهام/);

  const taskHeaders = {
    'content-type': 'application/json',
    Origin: origin,
    Cookie: ownerCookie,
    'X-ORIENT-CSRF': rotationBody.csrfToken,
    'Idempotency-Key': 'website-runtime-composition-task-0001'
  };
  const createResponse = await fetch(origin + '/api/v1/tasks', {
    method: 'POST',
    headers: taskHeaders,
    body: JSON.stringify({ goal: 'افحص المشروع' })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.apiVersion, 'v1');
  assert.equal(created.replayed, false);
  assert.ok(created.task.id);
  assert.equal(created.task.status, 'completed');

  const listResponse = await fetch(origin + '/api/v1/tasks?limit=20&offset=0', {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.ok(list.items.some(item => item.id === created.task.id));
  assert.ok(list.items.every(item => !Object.hasOwn(item, 'tenantId')));

  const detailResponse = await fetch(origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id), {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.task.id, created.task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(Object.hasOwn(detail.task, 'tenantId'), false);

  const ownerState = JSON.parse(fs.readFileSync(path.join(dataDir, 'owner.json'), 'utf8'));
  assert.equal(typeof ownerState.passwordHash, 'string');
  assert.equal(Object.hasOwn(ownerState, 'password'), false);
});
