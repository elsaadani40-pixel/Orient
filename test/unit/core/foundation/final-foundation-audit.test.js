const test = require('node:test');
const assert = require('node:assert/strict');

const OrientRuntime = require('../../../../src/core/runtime/orient-runtime');
const WorkflowWorker = require('../../../../src/core/workflow/workflow-worker');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

test('canonical runtime enables the tool execution authorization gate', () => {
  let required = false;
  const toolRegistry = {
    requireAuthorization() {
      required = true;
      return this;
    }
  };

  new OrientRuntime({
    toolRegistry,
    agentOrchestrator: {},
    authorizationService: {}
  });

  assert.equal(required, true);
});

test('runtime event persistence carries the authoritative tenant scope', () => {
  const calls = [];
  const toolRegistry = { requireAuthorization() {} };
  const persistence = {
    events: {
      appendMany(events, options) {
        calls.push({ events, options });
        return events;
      }
    }
  };

  const runtime = new OrientRuntime({
    toolRegistry,
    agentOrchestrator: {},
    persistence,
    tenantId: 'tenant-a'
  });

  const context = new ExecutionContext({
    requestId: 'audit-tenant',
    input: 'audit',
    tenantId: 'tenant-a'
  });
  context.record('audit.test', { value: true });

  const persisted = runtime.persistEvents(context);

  assert.equal(persisted.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.tenantId, 'tenant-a');
  assert.equal(calls[0].events[0].data.tenantId, 'tenant-a');
});

test('worker refuses to execute a step when durable lease renewal is lost', async () => {
  let executed = false;
  let released = false;

  const instance = {
    workflowId: 'lease-loss',
    state: 'RUNNING',
    cancelRequested: false,
    readySteps() {
      return [{ id: 'step-1' }];
    }
  };

  const scheduler = {
    lease() {
      return {
        workflowId: 'lease-loss',
        leaseId: 'lease-1',
        instance
      };
    },
    renew() {
      throw Object.assign(new Error('lease ownership lost'), {
        code: 'WORKFLOW_LEASE_NOT_OWNER'
      });
    },
    release() {
      released = true;
    }
  };

  const worker = new WorkflowWorker({
    scheduler,
    executor: async () => {
      executed = true;
      return { ok: true };
    },
    eventSink: () => {}
  });

  await assert.rejects(
    () => worker.tick(),
    error => error.code === 'WORKFLOW_LEASE_NOT_OWNER'
  );

  assert.equal(executed, false);
  assert.equal(released, true);
});


test('application and HTTP layers cannot bypass the canonical runtime', () => {
  const fs = require('fs');
  const path = require('path');
  const repositoryRoot = path.resolve(__dirname, '../../../..');
  const forbiddenImports = [
    'core/execution/agent-loop',
    'core/agent/orchestrator/agent-orchestrator',
    'core/runtime/request-execution-coordinator'
  ];

  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  }

  for (const layer of ['src/application', 'src/interfaces']) {
    collect(path.join(repositoryRoot, layer));
  }

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenImports) {
      assert.equal(
        pattern.test(source),
        false,
        `Canonical runtime bypass detected in ${path.relative(repositoryRoot, file)}: ${pattern}`
      );
    }
  }
});
