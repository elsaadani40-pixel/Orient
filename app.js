const fs = require('node:fs');
const path = require('node:path');
const config = require('./src/core/config');
const logger = require('./src/core/logging/logger');

const JsonMemoryRepository =
  require('./src/infrastructure/memory/json-memory.repository');

const MemoryService =
  require('./src/application/memory/memory.service');
const MemoryAuditRepository =
  require('./src/infrastructure/memory/memory-audit.repository');
const MemoryTransactionCoordinator =
  require('./src/infrastructure/memory/memory-transaction-coordinator');
const JsonAccessAuditRepository =
  require('./src/infrastructure/security/json-access-audit.repository');
const OwnerIdentityService =
  require('./src/core/security/owner-identity-service');
const OwnerIdentityRuntimeAdapter =
  require('./src/core/security/owner-identity-runtime-adapter');
const { createOwnerServer } = require('./server');

const AgentRegistry =
  require('./src/core/agent/boundary/agent-registry');
const AgentInvocationService =
  require('./src/core/agent/invocation/agent-invocation-service');
const { registerDefaultAgents } =
  require('./src/core/agent/catalog/default-agents');
const MemoryAccessPolicy =
  require('./src/core/memory/memory-access-policy');

const ToolRegistry =
  require('./src/core/tools/tool.registry');

const PlannerService =
  require('./src/application/planner/planner.service');

const createMemoryTools =
  require('./src/application/tools/memory.tools');
const ProjectBuilderAgent =
  require('./src/core/agent/project-builder/project-builder-agent');

const createWorkspaceTools =
  require('./src/application/tools/workspace.tools');
const createProjectTools =
  require('./src/application/tools/project.tools');
const ProjectOperationReceiptStore =
  require('./src/infrastructure/execution/project-operation-receipt-store');

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
const CapabilityGovernance =
  require('./src/core/agent/capability/capability-governance');

const createPersistence =
  require('./src/infrastructure/persistence/persistence-factory');

const { OwnerWorkProfileStore } =
  require('./src/infrastructure/persistence/owner-work-profile-store');

const { OwnerChatConversationStore } =
  require('./src/infrastructure/persistence/owner-chat-conversation-store');


const AgentOrchestrator =
  require('./src/core/agent/orchestrator/agent-orchestrator');
const ModelRouter =
  require('./src/core/model/model-router');
const ModelRoutingPolicy =
  require('./src/core/model/model-routing-policy');
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

const memoryAuditFile = path.join(config.agentDataDirectory, 'memory-audit.json');
let repository;
let memoryAuditRepository;
let memoryTransactionCoordinator = null;

if (persistence.memory && persistence.memoryAudit) {
  // SQLite memory and audit records share one database transaction.
  repository = persistence.memory;
  memoryAuditRepository = persistence.memoryAudit;
  const database = persistence.db;
  memoryTransactionCoordinator = {
    run: operation => database.transaction(operation),
    read: operation => operation(),
    tryRead: operation => operation()
  };
} else {
  memoryTransactionCoordinator = new MemoryTransactionCoordinator({
    memoryFile: config.dataFile,
    auditFile: memoryAuditFile,
    journalFile: path.join(config.agentDataDirectory, 'memory-transaction-journal.json')
  });
  // Recover interrupted JSON transactions before repository reads or HTTP startup.
  memoryTransactionCoordinator.recover();
  repository = new JsonMemoryRepository(config.dataFile);
  memoryAuditRepository = new MemoryAuditRepository(memoryAuditFile);
}

const agentRegistry =
  new AgentRegistry();

registerDefaultAgents(agentRegistry);

const memoryAccessPolicy =
  new MemoryAccessPolicy({
    agentRegistry
  });

const agentInvocationService =
  new AgentInvocationService({
    agentRegistry
  });

const accessAuditRepository =
  new JsonAccessAuditRepository(
    require('path').join(config.agentDataDirectory, 'access-audit.jsonl')
  );

const websiteDataDir = process.env.ORIENT_DATA_DIR || path.join(__dirname, '.orient-data');
const ownerBootstrapPassword = process.env.ORIENT_OWNER_BOOTSTRAP_PASSWORD || process.env.ORIENT_OWNER_PASSWORD;
const ownerStateFile = path.join(websiteDataDir, 'owner.json');
let ownerWorkProfileStore;
let ownerChatConversationStore;
if (!fs.existsSync(ownerStateFile) && !ownerBootstrapPassword) {
  throw new Error('First-run owner setup requires ORIENT_OWNER_BOOTSTRAP_PASSWORD (minimum 14 characters). Set it in the local environment before starting ORIENT.');
}
const ownerIdentityService = new OwnerIdentityService({
  // Keep the website's established state path so legacy owner credentials and
  // public accounts are migrated in place rather than silently abandoned.
  stateFile: require('path').join(websiteDataDir, 'owner.json'),
  bootstrapPassword: ownerBootstrapPassword
});
const ownerAuthService = new OwnerIdentityRuntimeAdapter({ identity: ownerIdentityService });
const website = createOwnerServer({
  dataDir: websiteDataDir,
  identity: ownerAuthService,
  log: () => {}
});
if (ownerIdentityService.createdBootstrap) {
  // The configured bootstrap secret is never written to logs or stdout.
  ownerIdentityService.consumeBootstrapPassword();
  console.error('ORIENT owner identity initialized for Admin. Change the configured bootstrap password after first sign-in.');
}

const memoryService =
  new MemoryService(repository, {
    memoryAccessPolicy,
    defaultScope: 'personal',
    auditRepository: memoryAuditRepository,
    transactionCoordinator: memoryTransactionCoordinator
  });

const toolRegistry =
  new ToolRegistry();

const planner =
  new PlannerService({ toolRegistry });

const memoryTools =
  createMemoryTools(memoryService);

const projectBuilderAgent = new ProjectBuilderAgent({
  projectRoot: __dirname,
  policy: {
    allowRead: true,
    allowWrite: true,
    allowCommands: false,
    allowGit: false,
    maxOutput: 30000
  }
});
const workspaceTools = createWorkspaceTools(projectBuilderAgent);
const projectOperationReceiptStore = new ProjectOperationReceiptStore({
  directory: path.join(config.agentDataDirectory, 'project-operation-receipts')
});
const projectTools = createProjectTools({
  projectRoot: __dirname,
  policy: {
    allowRead: true,
    allowWrite: true,
    allowCommands: false,
    allowGit: false,
    maxOutput: 30000
  },
  operationReceiptStore: projectOperationReceiptStore
});

// Prefer the explicitly governed project tools over the legacy workspace
// aliases with the same names. Registry registration remains startup-only.
const projectToolNames = new Set(projectTools.map(tool => tool.name));
const uniqueWorkspaceTools = workspaceTools.filter(tool => !projectToolNames.has(tool.name));

for (const tool of [...memoryTools, ...uniqueWorkspaceTools, ...projectTools]) {
  toolRegistry.register(tool);
}

// Tool registration is a startup-only operation. Seal the production registry
// before the runtime is constructed so later code cannot add executable tools.
toolRegistry.seal();

const observationBus =
  new ObservationBus();

const eventStore =
  new AgentEventStore();

memoryAuditRepository.setEventSink(
  (event) => eventStore.append(event)
);

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

const capabilityGovernance =
  new CapabilityGovernance({
    capabilityMapper,
    capabilityRegistry,
    agentRegistry
  });

const decisionEngine =
  new DecisionEngine();

const recoveryEngine =
  new RecoveryEngine();

const planValidator =
  new PlanValidator({
    maxSteps: 5,
    toolRegistry
  });

const replanner =
  new Replanner({
    maxReplans: 3
  });

const modelRoutingPolicy =
  new ModelRoutingPolicy({
    agentRegistry,
    allowRemote: false
  });

const modelRouter =
  new ModelRouter({
    policy: modelRoutingPolicy.asFunction()
  });

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

const persistenceRuntime = createPersistence(config);
const persistence = persistenceRuntime.adapter;

// PostgreSQL mode stores the owner work profile in the same durable database;
// JSON mode retains the restrictive local file-backed implementation.
ownerWorkProfileStore = persistence.ownerProfile || new OwnerWorkProfileStore({
  filePath: path.join(websiteDataDir, 'owner-work-profile.json')
});

// PostgreSQL deployments use the transactional repository backed by the same
// persistence pool and lifecycle; JSON deployments retain the local file store.
ownerChatConversationStore = persistence.ownerChat || new OwnerChatConversationStore({
  filePath: path.join(websiteDataDir, 'owner-chat-conversation.json')
});

const runtime =
  new OrientRuntime({
    toolRegistry,
    agentOrchestrator,
    authorizationService,
    persistence,
    tenantId: config.defaultTenantId,
    maxQueueDepth: config.maxQueueDepth,
    workflowDispatchWindow: config.workflowDispatchWindow,
    workflowAgingQuantumMs: config.workflowAgingQuantumMs,
    maxRetries: config.maxWorkflowRetries,
    leaseDurationMs: config.workflowLeaseMs,
    maxInputChars: config.maxInputChars,
    maxToolInputChars: config.maxToolInputChars,
    agentRegistry,
    agentInvocationService,
    capabilityGovernance,
    approvalDecisionAuthorizer: ({ actorId }) => ownerAuthService.isActiveSession(actorId)
  });

const agentService =
  new AgentService(runtime);

const memoryRoutes =
  createMemoryRoutes(
    memoryService,
    config
  );

async function persistOwnerFinalAnswer(executionId) {
  if (typeof executionId !== 'string' || !executionId) return;
  try {
    const status = await agentService.getExecutionStatus(executionId);
    if (status.status !== 'completed') return;
    const answer = await agentService.getFinalAnswer(executionId);
    if (typeof answer?.text !== 'string' || !answer.text.trim()) return;
    const safeExecutionId = executionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    await ownerChatConversationStore.appendAssistantForTask({
      id: 'assistant-' + safeExecutionId,
      role: 'assistant',
      content: answer.text,
      taskId: executionId
    });
  } catch (error) {
    logger.error('Owner chat final answer persistence failed', {
      code: error?.code || 'OWNER_CHAT_ANSWER_WRITE_FAILED'
    });
  }
}

const agentRoutes =
  createAgentRoutes(agentService, {
    async onTaskCreated({ executionId, messageId }) {
      try {
        await ownerChatConversationStore.attachTaskId(messageId, executionId);
      } catch (error) {
        logger.error('Owner chat task linkage failed', {
          code: error?.code || 'OWNER_CHAT_TASK_LINK_FAILED'
        });
      }
      // Persist immediately when task execution already completed, rather than
      // relying exclusively on a connected browser polling the response route.
      await persistOwnerFinalAnswer(executionId);
    },
    async onFinalAnswer({ executionId, text }) {
      if (typeof text !== 'string' || !text.trim()) return;
      const safeExecutionId = String(executionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
      try {
        await ownerChatConversationStore.appendAssistantForTask({
          id: 'assistant-' + safeExecutionId,
          role: 'assistant',
          content: text,
          taskId: executionId
        });
      } catch (error) {
        logger.error('Owner chat final answer persistence failed', {
          code: error?.code || 'OWNER_CHAT_ANSWER_WRITE_FAILED'
        });
      }
    }
  });

const server =
  createServer({
    memoryRoutes,
    agentRoutes,
    accessAudit: accessAuditRepository,
    ownerAuth: ownerAuthService,
    ownerProfile: ownerWorkProfileStore,
    ownerChatStore: ownerChatConversationStore,
    ownerChatHistoryResolver: async messages => {
      const answeredTaskIds = new Set(
        messages.filter(message => message.role === 'assistant' && message.taskId)
          .map(message => message.taskId)
      );
      const unresolved = messages.filter(message =>
        message.role === 'user' && message.taskId && !answeredTaskIds.has(message.taskId)
      ).slice(-25);
      for (const message of unresolved) {
        await persistOwnerFinalAnswer(message.taskId);
      }
    },
    websiteHandler: website.handler
  });

async function start() {
  if (typeof persistenceRuntime.initialize === 'function') {
    await persistenceRuntime.initialize();
  }
  await accessAuditRepository.initialize();

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
}

start().catch((error) => {
  logger.error('ORIENT ONE startup failed', {
    code: error?.code || 'STARTUP_FAILED',
    message: error?.message || String(error)
  });
  if (typeof persistenceRuntime.close === 'function') {
    persistenceRuntime.close().catch(() => {});
  }
  process.exitCode = 1;
});

const shutdownInOrder = require('./src/core/runtime/shutdown-in-order');

function shutdown(signal) {
  logger.info(
    'Server shutting down',
    { signal }
  );

  const forceExit = setTimeout(() => {
    process.exit(1);
  }, config.shutdownGraceMs);
  forceExit.unref();

  void shutdownInOrder({
    // server.close stops accepting new requests and resolves after active
    // connections have drained; only then may Runtime and persistence stop.
    closeIngress: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    stopObservations: () => eventStoreSubscriber.stop(),
    // Production async workers remain disabled until safety gate #189 passes.
    stopWorkers: async () => {},
    shutdownRuntime: () => runtime.shutdown({ cancelQueued: false }),
    closePersistence: () => (
      typeof persistenceRuntime.close === 'function'
        ? persistenceRuntime.close()
        : Promise.resolve()
    ),
    onError(stage, error) {
      const labels = {
        'http-ingress': 'HTTP ingress shutdown failed',
        observations: 'Event subscriber shutdown failed',
        workers: 'Worker shutdown failed',
        runtime: 'Runtime shutdown failed',
        persistence: 'Persistence shutdown failed'
      };
      logger.error(labels[stage] || 'Shutdown stage failed', {
        stage,
        code: error?.code || 'SHUTDOWN_STAGE_FAILED',
        message: error?.message || String(error)
      });
    }
  }).then((failures) => {
    clearTimeout(forceExit);
    process.exit(failures.length > 0 ? 1 : 0);
  }).catch((error) => {
    clearTimeout(forceExit);
    logger.error('Shutdown orchestration failed', {
      code: error?.code || 'SHUTDOWN_ORCHESTRATION_FAILED',
      message: error?.message || String(error)
    });
    process.exit(1);
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
