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
  const bootstrapOwnerCookie = cookie(login);
  let ownerCookie = bootstrapOwnerCookie;

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
  const staleOwnerSession = await fetch(origin + '/api/owner/me', {
    headers: { Cookie: bootstrapOwnerCookie }
  });
  assert.equal(staleOwnerSession.status, 401, 'password rotation must revoke the previous owner session');

  const registration = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'PublicRuntimeTest', password: 'public-test-password-2026!' })
  });
  assert.equal(registration.status, 201);
  const publicCookie = cookie(registration);
  const publicDenied = await fetch(origin + '/api/v1/tasks', { headers: { Cookie: publicCookie } });
  assert.equal(publicDenied.status, 401);
  const publicOwnerApiDenied = await fetch(origin + '/api/owner/users', { headers: { Cookie: publicCookie } });
  assert.equal(publicOwnerApiDenied.status, 401, 'public sessions must not access owner account-management APIs');

  // The public site, registration, personal account, owner console and
  // Runtime workbench must all be reachable through this one HTTP origin.
  for (const pathname of ['/', '/auth', '/auth.html', '/account.html']) {
    const response = await fetch(origin + pathname, {
      headers: { Cookie: publicCookie },
      redirect: 'manual'
    });
    assert.equal(response.status, 200, pathname + ' must be served by the integrated listener');
  }

  const ownerPage = await fetch(origin + '/owner', { headers: { Cookie: ownerCookie }, redirect: 'manual' });
  assert.equal(ownerPage.status, 200);
  assert.match(await ownerPage.text(), /Owner|ORIENT|owner/i);
  const workbench = await fetch(origin + '/workbench', { headers: { Cookie: ownerCookie }, redirect: 'manual' });
  assert.equal(workbench.status, 200);
  assert.match(await workbench.text(), /workbench|task|ORIENT/i);
  for (const pathname of ['/owner', '/workbench']) {
    const response = await fetch(origin + pathname, {
      headers: { Cookie: publicCookie },
      redirect: 'manual'
    });
    assert.equal(response.status, 302, pathname + ' must not grant public users owner/runtime page access');
    assert.match(response.headers.get('location') || '', /^\/auth\?mode=owner$/);
  }

  // Disabling a public account must revoke existing sessions permanently;
  // re-enabling the account must not revive the old cookie.
  const usersResponse = await fetch(origin + '/api/owner/users', { headers: { Cookie: ownerCookie } });
  assert.equal(usersResponse.status, 200);
  const users = await usersResponse.json();
  const publicUser = users.users.find(user => user.username === 'PublicRuntimeTest');
  assert.ok(publicUser?.id);
  for (const disabled of [true, false]) {
    const response = await fetch(origin + '/api/owner/users/' + publicUser.id + '/status', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: origin,
        Cookie: ownerCookie,
        'X-ORIENT-CSRF': rotationBody.csrfToken
      },
      body: JSON.stringify({ disabled })
    });
    assert.equal(response.status, 200);
  }
  const stalePublicSession = await fetch(origin + '/api/auth/me', { headers: { Cookie: publicCookie } });
  assert.equal(stalePublicSession.status, 401);

  const ownerDashboard = await fetch(origin + '/dashboard.html', { headers: { Cookie: ownerCookie } });
  assert.equal(ownerDashboard.status, 200);
  const dashboardHtml = await ownerDashboard.text();
  assert.match(dashboardHtml, /id="runtime-status"/);
  assert.match(dashboardHtml, /id="refresh-runtime"/);
  assert.match(dashboardHtml, /api\/v1\/tasks\?limit=1&offset=0/);
  assert.match(dashboardHtml, /href="\/workbench"/);

  const taskHeaders = {
    'content-type': 'application/json',
    Origin: origin,
    Cookie: ownerCookie,
    'X-ORIENT-CSRF': rotationBody.csrfToken,
    'Idempotency-Key': 'website-runtime-composition-task-0001'
  };
  const chatWithoutCsrf = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin, Cookie: ownerCookie },
    body: JSON.stringify({ message: 'لا يجب تنفيذ هذا الطلب دون CSRF' })
  });
  assert.equal(chatWithoutCsrf.status, 403, 'owner chat must require the existing owner CSRF token');

  const chatWrongOrigin = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: 'https://attacker.invalid',
      Cookie: ownerCookie,
      'X-ORIENT-CSRF': rotationBody.csrfToken
    },
    body: JSON.stringify({ message: 'لا يجب تنفيذ هذا الطلب من مصدر آخر' })
  });
  assert.equal(chatWrongOrigin.status, 403, 'owner chat must reject cross-origin requests');

  const chatInvalidMessage = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      Cookie: ownerCookie,
      'X-ORIENT-CSRF': rotationBody.csrfToken
    },
    body: JSON.stringify({ message: '   ', tenantId: 'attacker-tenant', role: 'admin', approval: { approved: true } })
  });
  assert.equal(chatInvalidMessage.status, 400, 'blank chat messages must be rejected');

  const publicChatDenied = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      Cookie: publicCookie,
      'X-ORIENT-CSRF': rotationBody.csrfToken
    },
    body: JSON.stringify({ message: 'public users must not reach the owner Runtime' })
  });
  assert.equal(publicChatDenied.status, 401, 'public account sessions must not access owner chat');

  const chatResponse = await fetch(origin + '/owner/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: origin,
      Cookie: ownerCookie,
      'X-ORIENT-CSRF': rotationBody.csrfToken,
      'Idempotency-Key': 'website-owner-chat-ingress-0001'
    },
    body: JSON.stringify({
      message: 'افحص المشروع من خلال Runtime',
      tenantId: 'attacker-tenant',
      userId: 'attacker-user',
      workspaceId: 'attacker-workspace',
      role: 'admin',
      approval: { approved: true },
      capabilities: ['*']
    })
  });
  assert.equal(chatResponse.status, 201, 'authenticated owner chat must enter the canonical Runtime task service');
  const chatResult = await chatResponse.json();
  assert.equal(chatResult.apiVersion, 'v1');
  assert.ok(chatResult.task?.id);
  assert.equal(chatResult.task.status, 'completed');

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
  assert.ok(Number.isSafeInteger(list.page?.total) && list.page.total >= 1, 'task list must expose a valid total for the owner dashboard Runtime indicator');
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
