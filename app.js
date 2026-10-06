const config = require('./src/core/config');
const logger = require('./src/core/logging/logger');

const JsonMemoryRepository =
  require('./src/infrastructure/memory/json-memory.repository');

const MemoryService =
  require('./src/application/memory/memory.service');

const AgentRegistry =
  require('./src/core/agent/boundary/agent-registry');
const { AgentDefinition } =
  require('./src/core/agent/boundary/agent-definition');
const MemoryAccessPolicy =
  require('./src/core/memory/memory-access-policy');

const ToolRegistry =
  require('./src/core/tools/tool.registry');

const PlannerService =
  require('./src/application/planner/planner.service');

const createMemoryTools =
  require('./src/application/tools/memory.tools');

const OrientRuntime =
  require('./src/core/runtime/orient-runtime');

const AgentService =
  require('./src/application/agent/agent.service');

const ObservationBus =
  require('./src/core/agent/observation/observation-bus');

const AgentEventStore =
  require('./src/core/agent/observation/agent-event-store');

const AgentEventPublisher =
  require('./src/core/agent/observation/agent-event-publisher');

const EventStoreSubscriber =
  require('./src/core/agent/observation/event-store-subscriber');

const CapabilityRegistry =
  require('./src/core/agent/capability/capability-registry');

const CapabilityMapper =
  require('./src/core/agent/capability/capability-mapper');

const registerDefaultCapabilities =
  require('./src/core/agent/capability/default-capabilities');

const registerDefaultToolCapabilities =
  require('./src/core/agent/capability/default-tool-capabilities');

const CapabilityPolicy =
  require('./src/core/agent/policy/capability-policy');

const AuthorizationService =
  require('./src/core/agent/authorization/authorization-service');

const JsonPersistence =
  require('./src/infrastructure/persistence/json-persistence');


const AgentOrchestrator =
  require('./src/core/agent/orchestrator/agent-orchestrator');
const ModelRouter =
  require('./src/core/model/model-router');
const OllamaProvider =
  require('./src/infrastructure/model/ollama.provider');

const DecisionEngine =
  require('./src/core/agent/decision/decision-engine');

const RecoveryEngine =
  require('./src/core/agent/recovery/recovery-engine');

const PlanValidator =
  require('./src/core/planning/validation/plan-validator');

const Replanner =
  require('./src/core/planning/replanning/replanner');

const createMemoryRoutes =
  require('./src/interfaces/http/routes/memory.routes');

const createAgentRoutes =
  require('./src/interfaces/http/routes/agent.routes');

const createServer =
  require('./src/interfaces/http/server');

const repository =
  new JsonMemoryRepository(config.dataFile);

const agentRegistry =
  new AgentRegistry();

agentRegistry.register(new AgentDefinition({
  id: 'ORIENT_RUNTIME',
  name: 'ORIENT Canonical Runtime',
  capabilities: ['*'],
  allowedMemoryScopes: ['*'],
  allowedAgentTargets: ['*'],
  risk: 'critical'
}));

const memoryAccessPolicy =
  new MemoryAccessPolicy({
    agentRegistry
  });

const memoryService =
  new MemoryService(repository, {
    memoryAccessPolicy,
    defaultScope: 'personal'
  });

const toolRegistry =
  new ToolRegistry();

const planner =
  new PlannerService();

const memoryTools =
  createMemoryTools(memoryService);

for (const tool of memoryTools) {
  toolRegistry.register(tool);
}

const observationBus =
  new ObservationBus();

const eventStore =
  new AgentEventStore();

const eventPublisher =
  new AgentEventPublisher(
    observationBus
  );

const eventStoreSubscriber =
  new EventStoreSubscriber({
    observationBus,
    eventStore
  });

eventStoreSubscriber.start();

const capabilityRegistry =
  new CapabilityRegistry();

registerDefaultCapabilities(
  capabilityRegistry
);

const capabilityMapper =
  new CapabilityMapper();

registerDefaultToolCapabilities(
  capabilityMapper
);

const capabilityPolicy =
  new CapabilityPolicy({
    capabilityRegistry
  });

const authorizationService =
  new AuthorizationService({
    capabilityMapper,
    capabilityPolicy
  });

const decisionEngine =
  new DecisionEngine();

const recoveryEngine =
  new RecoveryEngine();

const planValidator =
  new PlanValidator({
    maxSteps: 5
  });

const replanner =
  new Replanner({
    maxReplans: 3
  });

const modelRouter =
  new ModelRouter();

if (config.modelProvider === 'ollama') {
  modelRouter.register(new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    timeoutMs: config.ollamaTimeoutMs
  }));
}

const agentOrchestrator =
  new AgentOrchestrator({
    planner,
    planValidator,
    replanner,
    decisionEngine,
    recoveryEngine,
    eventPublisher,
    modelRouter
  });

const persistence =
  new JsonPersistence({
    dataDirectory: config.agentDataDirectory
  });

const runtime =
  new OrientRuntime({
    toolRegistry,
    agentOrchestrator,
    authorizationService,
    persistence,
    tenantId: config.defaultTenantId,
    maxQueueDepth: config.maxQueueDepth,
    maxRetries: config.maxWorkflowRetries,
    leaseDurationMs: config.workflowLeaseMs,
    maxInputChars: config.maxInputChars,
    maxToolInputChars: config.maxToolInputChars,
    agentRegistry
  });

const agentService =
  new AgentService(runtime);

const memoryRoutes =
  createMemoryRoutes(
    memoryService,
    config
  );

const agentRoutes =
  createAgentRoutes(
    agentService
  );

const server =
  createServer({
    memoryRoutes,
    agentRoutes
  });

server.listen(
  config.port,
  config.host,
  () => {
    logger.info(
      `${config.appName} started`,
      {
        version: config.version,
        host: config.host,
        port: config.port,
        tools: toolRegistry.list().map(
          (tool) => tool.name
        ),
        eventStore: 'READY',
        agentOrchestrator: 'READY'
      }
    );

    console.log('');
    console.log(
      `✅ ${config.appName} v${config.version} شغال`
    );
    console.log(
      `🌐 http://127.0.0.1:${config.port}`
    );
    console.log(
      `🧠 Memory Core: READY`
    );
    console.log(
      `🛠️ Tool Registry: ${toolRegistry.list().length} TOOLS`
    );
    console.log(
      `📡 Event Bus: READY`
    );
    console.log(
      `🗄️ Event Store: READY`
    );
    console.log(
      `🤖 Agent Orchestrator: READY`
    );
    console.log(
      `🤖 Agent Runtime: READY`
    );
    console.log('');
    console.log(
      'Tools:',
      toolRegistry.list()
        .map((tool) => tool.name)
        .join(', ')
    );
    console.log('');
  }
);

function shutdown(signal) {
  logger.info(
    'Server shutting down',
    { signal }
  );

  eventStoreSubscriber.stop();

  try {
    runtime.shutdown({ cancelQueued: false });
  } catch (error) {
    logger.error('Runtime shutdown failed', {
      code: error?.code || 'RUNTIME_SHUTDOWN_FAILED',
      message: error?.message || String(error)
    });
  }

  const forceExit = setTimeout(() => {
    process.exit(1);
  }, config.shutdownGraceMs);
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);
