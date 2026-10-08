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

function createRuntime(root) {
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
  return new OrientRuntime({ toolRegistry, agentOrchestrator: orchestrator, tenantId: 'tenant-mission', agentRegistry: registry });
}

test('project audit mission completes through canonical runtime without write or command access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'AGENT.md'), '# test');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"mission-fixture"}');
  const runtime = createRuntime(root);
  const result = await runtime.execute('افحص المشروع');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.result.status, 'healthy');
  assert.equal(result.result.score, 100);
  assert.equal(result.result.recommendation, 'safe-to-proceed');
  assert.equal(result.result.definitionOfDone.satisfied, true);
  assert.equal(result.result.audit.modificationAllowed, false);
  assert.equal(result.result.audit.commandExecutionAllowed, false);
  assert.equal(result.execution.status, 'completed');
  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('project change-proposal mission finds a real issue and never executes the proposal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-proposal-'));
  fs.mkdirSync(path.join(root, 'test'));
  const manifestPath = path.join(root, 'package.json');
  const original = '{"name":"proposal-fixture"}\n';
  fs.writeFileSync(manifestPath, original);
  const runtime = createRuntime(root);
  const result = await runtime.execute('حلل المشروع واكتشف مشكلة واقترح تغييرًا آمنًا');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.result.status, 'actionable');
  assert.equal(result.result.execution.allowed, false);
  assert.equal(result.result.execution.performed, false);
  assert.equal(result.result.findings[0].id, 'missing-test-script');
  assert.equal(result.result.proposals.length, 1);
  assert.equal(result.result.proposals[0].action, 'update');
  assert.equal(result.result.proposals[0].path, 'package.json');
  assert.match(result.result.proposals[0].content, /"test": "node --test"/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);
  runtime.shutdown({ cancelQueued: false });
  fs.rmSync(root, { recursive: true, force: true });
});
