const path = require('path');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const config = Object.freeze({
  port: positiveInteger(process.env.PORT, 8080),
  host: process.env.HOST || '127.0.0.1',
  nodeEnv: process.env.NODE_ENV || 'development',
  persistenceMode: process.env.ORIENT_PERSISTENCE || 'json',
  databaseUrl: process.env.ORIENT_DATABASE_URL || process.env.DATABASE_URL || '',
  databasePoolMax: positiveInteger(process.env.ORIENT_DATABASE_POOL_MAX, 10),
  databaseIdleTimeoutMs: positiveInteger(process.env.ORIENT_DATABASE_IDLE_TIMEOUT_MS, 30000),
  databaseConnectionTimeoutMs: positiveInteger(process.env.ORIENT_DATABASE_CONNECTION_TIMEOUT_MS, 5000),
  defaultTenantId: process.env.ORIENT_TENANT_ID || 'local',
  dataFile: path.join(__dirname, '../../../data/memories.json'),
  agentDataDirectory: path.join(__dirname, '../../../data/agent'),
  maxInputChars: positiveInteger(process.env.ORIENT_MAX_INPUT_CHARS, 100000),
  maxToolInputChars: positiveInteger(process.env.ORIENT_MAX_TOOL_INPUT_CHARS, 50000),
  maxQueueDepth: positiveInteger(process.env.ORIENT_MAX_QUEUE_DEPTH, 1000),
  workflowDispatchWindow: positiveInteger(process.env.ORIENT_WORKFLOW_DISPATCH_WINDOW, 2),
  workflowAgingQuantumMs: positiveInteger(process.env.ORIENT_WORKFLOW_AGING_QUANTUM_MS, 30000),
  maxWorkflowRetries: Number.isInteger(Number(process.env.ORIENT_MAX_WORKFLOW_RETRIES))
    && Number(process.env.ORIENT_MAX_WORKFLOW_RETRIES) >= 0
    ? Number(process.env.ORIENT_MAX_WORKFLOW_RETRIES)
    : 2,
  workflowLeaseMs: positiveInteger(process.env.ORIENT_WORKFLOW_LEASE_MS, 30000),
  shutdownGraceMs: positiveInteger(process.env.ORIENT_SHUTDOWN_GRACE_MS, 10000),
  modelProvider: process.env.ORIENT_MODEL_PROVIDER || 'none',
  ollamaBaseUrl: process.env.ORIENT_OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.ORIENT_OLLAMA_MODEL || 'llama3.2:3b',
  ollamaTimeoutMs: positiveInteger(process.env.ORIENT_OLLAMA_TIMEOUT_MS, 60000),
  appName: 'ORIENT ONE',
  version: '0.12.0'
});

module.exports = config;
