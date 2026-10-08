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

test('project audit mission completes through canonical runtime without write or command access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'AGENT.md'), '# test');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"mission-fixture"}');

  const registry = new AgentRegistry();
  registerDefaultAgents(registry);
  const toolRegistry = new ToolRegistry();
  for (const tool of createProjectTools({ projectRoot: root })) toolRegistry.register(tool);

  const orchestrator = new AgentOrchestrator({
    planner: new PlannerService(),
    planValidator: new PlanValidator({ maxSteps: 5, toolRegistry }),
    replanner: new Replanner({ maxReplans: 1 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine()
  });
  const runtime = new OrientRuntime({ toolRegistry, agentOrchestrator: orchestrator, tenantId: 'tenant-mission', agentRegistry: registry });

  const result = await runtime.execute('افحص المشروع');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.result.status, 'healthy');
  assert.equal(result.result.audit.modificationAllowed, false);
  assert.equal(result.result.audit.commandExecutionAllowed, false);
  assert.equal(result.result.projectRoot, root);
  assert.equal(result.execution.status, 'completed');

  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});
