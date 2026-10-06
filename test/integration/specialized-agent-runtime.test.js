const test = require('node:test');
const assert = require('node:assert/strict');

const AgentRegistry = require('../../src/core/agent/boundary/agent-registry');
const { registerDefaultAgents } = require('../../src/core/agent/catalog/default-agents');
const ModelRouter = require('../../src/core/model/model-router');
const ModelRoutingPolicy = require('../../src/core/model/model-routing-policy');
const PlannerService = require('../../src/application/planner/planner.service');
const PlanValidator = require('../../src/core/planning/validation/plan-validator');
const Replanner = require('../../src/core/planning/replanning/replanner');
const DecisionEngine = require('../../src/core/agent/decision/decision-engine');
const RecoveryEngine = require('../../src/core/agent/recovery/recovery-engine');
const AgentOrchestrator = require('../../src/core/agent/orchestrator/agent-orchestrator');
const ToolRegistry = require('../../src/core/tools/tool.registry');
const OrientRuntime = require('../../src/core/runtime/orient-runtime');

test('specialized agent completes a real end-to-end model-planned task through canonical runtime', async () => {
  const registry = new AgentRegistry();
  registerDefaultAgents(registry);

  const modelRouter = new ModelRouter({
    policy: new ModelRoutingPolicy({
      agentRegistry: registry
    }).asFunction(),
    providers: [
      {
        id: 'test.local',
        locality: 'local',
        costClass: 'free',
        capabilities: ['text-generation'],
        async complete() {
          return {
            text: JSON.stringify({
              intent: 'memory.search',
              confidence: 0.99,
              reason: 'specialized agent test',
              steps: [
                {
                  tool: 'memory.search',
                  input: 'القاهرة',
                  dependsOn: null
                }
              ]
            })
          };
        }
      }
    ]
  });

  const toolRegistry = new ToolRegistry();
  let executionContext = null;

  toolRegistry.register({
    name: 'memory.search',
    description: 'test memory search',
    async execute(input, context) {
      executionContext = {
        agentId: context.agentId,
        capability: context.capability,
        tenantId: context.tenantId
      };

      return {
        query: input,
        memories: ['Alexandria', 'Cairo']
      };
    }
  });

  const planner = new PlannerService();
  const planValidator = new PlanValidator({
    maxSteps: 5,
    toolRegistry
  });

  const orchestrator = new AgentOrchestrator({
    planner,
    planValidator,
    replanner: new Replanner({ maxReplans: 1 }),
    decisionEngine: new DecisionEngine(),
    recoveryEngine: new RecoveryEngine(),
    modelRouter
  });

  const runtime = new OrientRuntime({
    toolRegistry,
    agentOrchestrator: orchestrator,
    tenantId: 'tenant-e2e',
    agentRegistry: registry
  });

  const result = await runtime.execute('ابحث عن القاهرة');

  assert.equal(result.type, 'memory_result');
  assert.equal(result.result.query, 'القاهرة');
  assert.equal(executionContext.agentId, 'MEMORY_AGENT');
  assert.equal(executionContext.capability, 'tool:memory.search');
  assert.equal(executionContext.tenantId, 'tenant-e2e');

  runtime.shutdown({ cancelQueued: false });
});
