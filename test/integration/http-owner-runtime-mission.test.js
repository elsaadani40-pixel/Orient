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

  // Exercise the canonical cross-device task API against the same real runtime.
  const taskHeaders = {
    'content-type': 'application/json',
    Origin: origin,
    Cookie: cookie,
    'Idempotency-Key': 'owner-runtime-task-key-0001'
  };
  const taskResponse = await fetch(origin + '/api/v1/tasks', {
    method: 'POST',
    headers: taskHeaders,
    body: JSON.stringify({ goal: 'افحص المشروع' })
  });
  assert.equal(taskResponse.status, 201);
  const created = await taskResponse.json();
  assert.equal(created.apiVersion, 'v1');
  assert.equal(created.replayed, false);
  assert.ok(created.task.id);
  assert.equal(created.task.status, 'completed');

  const replayResponse = await fetch(origin + '/api/v1/tasks', {
    method: 'POST',
    headers: taskHeaders,
    body: JSON.stringify({ goal: 'افحص المشروع' })
  });
  assert.equal(replayResponse.status, 200);
  const replayed = await replayResponse.json();
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.task.id, created.task.id, 'idempotent replay must not create another execution');

  const conflictingReuse = await fetch(origin + '/api/v1/tasks', {
    method: 'POST',
    headers: taskHeaders,
    body: JSON.stringify({ goal: 'طلب مختلف لا يجوز تنفيذه بنفس المفتاح' })
  });
  assert.equal(conflictingReuse.status, 409);
  assert.match(await conflictingReuse.text(), /لا يمكن إعادة استخدام مفتاح منع التكرار لطلب مختلف/);

  const taskListResponse = await fetch(origin + '/api/v1/tasks?limit=20&offset=0', {
    headers: { Cookie: cookie }
  });
  assert.equal(taskListResponse.status, 200);
  const taskList = await taskListResponse.json();
  assert.ok(taskList.items.some(item => item.id === created.task.id));
  assert.ok(taskList.items.every(item => !Object.hasOwn(item, 'tenantId')), 'task list summaries must not disclose tenant identifiers');

  const deniedTaskDetail = await fetch(origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id));
  assert.equal(deniedTaskDetail.status, 401, 'task detail must require an owner session');

  const taskDetailResponse = await fetch(origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id), {
    headers: { Cookie: cookie }
  });
  assert.equal(taskDetailResponse.status, 200);
  const detail = await taskDetailResponse.json();
  assert.equal(detail.apiVersion, 'v1');
  assert.equal(detail.task.id, created.task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(Object.hasOwn(detail.task, 'tenantId'), false, 'public task summary must not disclose tenant identifiers');

  // Task event history is also owner-only and uses an explicit, bounded cursor.
  const deniedTaskEvents = await fetch(origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id) + '/events?limit=1');
  assert.equal(deniedTaskEvents.status, 401, 'task event history must require an owner session');

  const firstEventPageResponse = await fetch(
    origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id) + '/events?limit=1',
    { headers: { Cookie: cookie } }
  );
  assert.equal(firstEventPageResponse.status, 200);
  const firstEventPage = await firstEventPageResponse.json();
  assert.equal(firstEventPage.apiVersion, 'v1');
  assert.equal(firstEventPage.items.length, 1);
  const firstEvent = firstEventPage.items[0];
  assert.ok(firstEvent.id);
  assert.equal(firstEvent.taskId, created.task.id);
  assert.deepEqual(Object.keys(firstEvent).sort(), ['details', 'id', 'outcome', 'sequence', 'stepId', 'taskId', 'timestamp', 'type'], 'task events must expose only the documented allowlisted envelope');
  assert.equal(Object.hasOwn(firstEvent, 'tenantId'), false, 'public task events must not disclose tenant identifiers');
  assert.equal(firstEventPage.page.nextCursor, firstEvent.id);
  assert.equal(firstEventPage.page.hasMore, true, 'runtime mission should expose multiple events for cursor pagination');

  const nextEventPageResponse = await fetch(
    origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id) +
      '/events?limit=1&after=' + encodeURIComponent(firstEvent.id),
    { headers: { Cookie: cookie } }
  );
  assert.equal(nextEventPageResponse.status, 200);
  const nextEventPage = await nextEventPageResponse.json();
  assert.equal(nextEventPage.items.length, 1);
  assert.notEqual(nextEventPage.items[0].id, firstEvent.id, 'cursor pagination must not repeat the last delivered event');
  assert.equal(nextEventPage.items[0].taskId, created.task.id);

  const missingCursorResponse = await fetch(
    origin + '/api/v1/tasks/' + encodeURIComponent(created.task.id) +
      '/events?limit=1&after=cursor-that-does-not-exist',
    { headers: { Cookie: cookie } }
  );
  assert.equal(missingCursorResponse.status, 409, 'unknown event cursors must fail explicitly instead of silently skipping history');
  assert.match(await missingCursorResponse.text(), /Task event cursor is no longer available/);
});
