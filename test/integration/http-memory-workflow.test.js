const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const AgentRegistry = require('../../src/core/agent/boundary/agent-registry');
const { registerDefaultAgents } = require('../../src/core/agent/catalog/default-agents');
const MemoryAccessPolicy = require('../../src/core/memory/memory-access-policy');
const MemoryService = require('../../src/application/memory/memory.service');
const JsonMemoryRepository = require('../../src/infrastructure/memory/json-memory.repository');
const MemoryAuditRepository = require('../../src/infrastructure/memory/memory-audit.repository');
const createMemoryTools = require('../../src/application/tools/memory.tools');
const PlannerService = require('../../src/application/planner/planner.service');
const PlanValidator = require('../../src/core/planning/validation/plan-validator');
const Replanner = require('../../src/core/planning/replanning/replanner');
const DecisionEngine = require('../../src/core/agent/decision/decision-engine');
const RecoveryEngine = require('../../src/core/agent/recovery/recovery-engine');
const AgentOrchestrator = require('../../src/core/agent/orchestrator/agent-orchestrator');
const ToolRegistry = require('../../src/core/tools/tool.registry');
const OrientRuntime = require('../../src/core/runtime/orient-runtime');
const CapabilityRegistry = require('../../src/core/agent/capability/capability-registry');
const CapabilityMapper = require('../../src/core/agent/capability/capability-mapper');
const registerDefaultCapabilities = require('../../src/core/agent/capability/default-capabilities');
const registerDefaultToolCapabilities = require('../../src/core/agent/capability/default-tool-capabilities');
const CapabilityPolicy = require('../../src/core/agent/policy/capability-policy');
const AuthorizationService = require('../../src/core/agent/authorization/authorization-service');
const CapabilityGovernance = require('../../src/core/agent/capability/capability-governance');
const JsonPersistence = require('../../src/infrastructure/persistence/json/json-persistence');
const AgentService = require('../../src/application/agent/agent.service');
const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');
const createMemoryRoutes = require('../../src/interfaces/http/routes/memory.routes');
const createServer = require('../../src/interfaces/http/server');

test('HTTP memory task persists across repository restart and remains tenant-scoped', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-http-memory-'));
  const memoryFile = path.join(root, 'memories.json');
  const auditFile = path.join(root, 'memory-audit.json');
  const runtimeState = path.join(root, '.orient-state');
  const tenantId = 'tenant-http-memory';

  const agentRegistry = new AgentRegistry();
  registerDefaultAgents(agentRegistry);
  const memoryAccessPolicy = new MemoryAccessPolicy({ agentRegistry });
  const memoryAuditRepository = new MemoryAuditRepository(auditFile);
  const memoryRepository = new JsonMemoryRepository(memoryFile);
  const memoryService = new MemoryService(memoryRepository, {
    memoryAccessPolicy,
    defaultScope: 'personal',
    auditRepository: memoryAuditRepository
  });

  const toolRegistry = new ToolRegistry();
  for (const tool of createMemoryTools(memoryService)) {
    toolRegistry.register(tool);
  }
  toolRegistry.seal();

  const capabilityRegistry = new CapabilityRegistry();
  registerDefaultCapabilities(capabilityRegistry);
  const capabilityMapper = new CapabilityMapper();
  registerDefaultToolCapabilities(capabilityMapper);
  const authorizationService = new AuthorizationService({
    capabilityMapper,
    capabilityPolicy: new CapabilityPolicy({ capabilityRegistry })
  });
  const capabilityGovernance = new CapabilityGovernance({
    capabilityMapper,
    capabilityRegistry,
    agentRegistry
  });

  const agentOrchestrator = new AgentOrchestrator({
    planner: new PlannerService(),
    planValidator: new PlanValidator({ maxSteps: 5, toolRegistry }),
    replanner: new Replanner({ maxReplans: 1 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });
  const persistence = new JsonPersistence({ rootDir: runtimeState });
  const runtime = new OrientRuntime({
    toolRegistry,
    agentOrchestrator,
    authorizationService,
    capabilityGovernance,
    persistence,
    tenantId,
    agentRegistry
  });

  const config = { appName: 'ORIENT ONE', version: '0.12.0', defaultTenantId: tenantId };
  const server = createServer({
    memoryRoutes: createMemoryRoutes(memoryService, config),
    agentRoutes: createAgentRoutes(new AgentService(runtime))
  });

  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
    await runtime.shutdown({ cancelQueued: false });
    fs.rmSync(root, { recursive: true, force: true });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'احفظ أنني أختبر ORIENT ONE' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.type, 'tool_result');
  assert.equal(result.execution.status, 'completed');
  assert.equal(result.result.text, 'أنني أختبر ORIENT ONE');

  const homeResponse = await fetch(baseUrl);
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /أنني أختبر ORIENT ONE/);

  const restartedRepository = new JsonMemoryRepository(memoryFile);
  const restartedService = new MemoryService(restartedRepository, {
    memoryAccessPolicy,
    defaultScope: 'personal'
  });
  const context = {
    agentId: 'ORIENT_RUNTIME',
    tenantId,
    memoryScope: 'personal'
  };
  const recovered = restartedService.list('أختبر', context);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].text, 'أنني أختبر ORIENT ONE');

  const otherTenant = restartedService.list('أختبر', {
    ...context,
    tenantId: 'tenant-other'
  });
  assert.deepEqual(otherTenant, []);
});
