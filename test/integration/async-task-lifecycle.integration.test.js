'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JsonPersistence = require('../../src/infrastructure/persistence/json/json-persistence');
const AsyncWorkflowScheduler = require('../../src/core/workflow/async-workflow-scheduler');
const AsyncWorkflowWorker = require('../../src/core/workflow/async-workflow-worker');
const AsyncWorkflowWorkerService = require('../../src/core/workflow/async-workflow-worker-service');
const WorkflowExecutionCoordinator = require('../../src/core/runtime/workflow-execution-coordinator');
const ApprovalService = require('../../src/core/agent/approval/approval-service');
const AgentService = require('../../src/application/agent/agent.service');
const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');
const createServer = require('../../src/interfaces/http/server');
const OwnerAuthService = require('../../src/core/security/owner-auth-service');

const TENANT_ID = 'tenant-async-lifecycle';
const OWNER_PASSWORD = 'integration-owner-password-2026';

function createScheduler(persistence) {
  return new AsyncWorkflowScheduler({
    tenantId: TENANT_ID,
    workflowRepository: persistence.workflows,
    leaseRepository: persistence.workflowLeases,
    maxConcurrent: 1,
    maxQueueDepth: 20,
    leaseDurationMs: 30000,
    dispatchWindow: 2,
    agingQuantumMs: 1000
  });
}

function createCoordinator(scheduler, persistence) {
  return new WorkflowExecutionCoordinator({
    scheduler,
    workflowRepository: persistence.workflows,
    persistence,
    tenantId: TENANT_ID,
    executeRequest: async () => {
      throw Object.assign(new Error('The synchronous workflow path must not run'), {
        code: 'SYNC_EXECUTION_MUST_NOT_RUN'
      });
    }
  });
}

async function request(origin, route, { method = 'GET', headers = {}, body } = {}) {
  return fetch(origin + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('public async task is paused by the real worker and resumed by reconstructed Runtime after restart', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-async-real-runtime-e2e-'));
  const persistence = new JsonPersistence({ rootDir });
  const ownerAuth = new OwnerAuthService({ password: OWNER_PASSWORD });
  let approvalService = new ApprovalService({
    repository: persistence.approvals,
    tenantId: TENANT_ID,
    decisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId)
  });
  const executionPlan = {
    intent: 'resume.approved.operation',
    confidence: 1,
    agentId: 'ORIENT_RUNTIME',
    steps: [{
      step: 1,
      tool: 'danger.write',
      input: { resourceId: 'resource-worker-42' },
      dependsOn: null
    }]
  };
  const makeToolRegistry = () => ({
    has: tool => tool === 'danger.write',
    get: tool => ({ name: tool }),
    async execute(tool, input, executionContext) {
      assert.equal(tool, 'danger.write');
      assert.deepEqual(input, { resourceId: 'resource-worker-42' });
      assert.match(executionContext.idempotencyKey, /^[a-f0-9]{64}$/);
      assert.equal(executionContext.tenantId, TENANT_ID);
      sideEffects += 1;
      return { receipt: 'worker-paused-owner-approved-operation' };
    }
  });
  const makeAuthorizationService = service => ({
    approvalService: service,
    async assertAuthorized(tool, requestContext) {
      const validation = await service.validate({
        approval: requestContext.approval,
        executionId: requestContext.executionId,
        step: requestContext.step,
        planRevision: requestContext.planRevision,
        tool,
        capability: 'external.write',
        scope: { planRevision: requestContext.planRevision },
        tenantId: requestContext.tenantId
      });
      if (!validation.allowed) {
        throw Object.assign(new Error('Approval validation failed'), { code: validation.reason });
      }
      return {
        allowed: true,
        capability: 'external.write',
        risk: 'high',
        requiresApproval: true,
        approval: validation.approval
      };
    }
  });
  const agentOrchestrator = {
    decideReplanning() {
      return { nextAction: null, toJSON: () => ({ outcome: 'done', nextAction: null }) };
    },
    async recover(error) { throw error; }
  };
  const makeRuntime = service => new (require('../../src/core/runtime/orient-runtime'))({
    tenantId: TENANT_ID,
    userId: 'owner-user',
    workspaceId: 'owner-workspace',
    persistence,
    workflowScheduler: createScheduler(persistence),
    approvalService: service,
    approvalDecisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId),
    authorizationService: makeAuthorizationService(service),
    toolRegistry: makeToolRegistry(),
    agentOrchestrator
  });
  let sideEffects = 0;
  let workerExecutions = 0;
  let runtimeBeforeRestart = makeRuntime(approvalService);
  let runtimeAfterRestart = null;
  const agentService = new AgentService(runtimeBeforeRestart, { taskAcceptanceMode: 'async' });
  let server = createServer({ agentRoutes: createAgentRoutes(agentService), ownerAuth });
  let workerService = null;
  let workerErrors = [];
  let origin = null;
  let ownerHeaders = null;

  const startServerAndLogin = async () => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = 'http://127.0.0.1:' + server.address().port;
    const loginResponse = await request(origin, '/owner/login', {
      method: 'POST',
      headers: { Origin: origin },
      body: { password: OWNER_PASSWORD }
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const loginPayload = await loginResponse.json();
    ownerHeaders = {
      Origin: origin,
      Cookie: cookie,
      'X-ORIENT-CSRF': loginPayload.csrfToken
    };
  };
  const closeServer = async () => {
    if (!server?.listening) return;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await startServerAndLogin();

    const acceptedResponse = await request(origin, '/api/v1/tasks', {
      method: 'POST',
      headers: { ...ownerHeaders, 'Idempotency-Key': 'async-real-runtime-request-0001' },
      body: { goal: 'perform the protected operation' }
    });
    assert.equal(acceptedResponse.status, 201);
    const acceptedPayload = await acceptedResponse.json();
    const taskId = acceptedPayload.task.id;
    assert.equal(acceptedPayload.task.status, 'queued');
    assert.equal(acceptedPayload.task.workflowId, taskId);
    assert.equal(acceptedPayload.task.executionId, null);

    const replayResponse = await request(origin, '/api/v1/tasks', {
      method: 'POST',
      headers: { ...ownerHeaders, 'Idempotency-Key': 'async-real-runtime-request-0001' },
      body: { goal: 'perform the protected operation' }
    });
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json()).replayed, true);

    const scheduler = runtimeBeforeRestart.workflowScheduler;
    workerService = new AsyncWorkflowWorkerService({
      scheduler,
      pollIntervalMs: 50,
      recoveryIntervalMs: 1000,
      onError: error => workerErrors.push(error),
      workerFactory: (workerId, capabilities) => new AsyncWorkflowWorker({
        scheduler,
        workerId,
        tenantId: TENANT_ID,
        capabilities,
        executor: async ({ instance }) => {
          workerExecutions += 1;
          const executionId = 'execution-' + instance.workflowId;
          const issued = await approvalService.issue({
            executionId,
            step: 1,
            planRevision: 1,
            tool: 'danger.write',
            capability: 'external.write',
            scope: { planRevision: 1 },
            tenantId: TENANT_ID,
            ttlMs: 60000
          });

          // The real worker owns the durable WAITING transition. Persist the
          // execution checkpoint at the exact point where this worker requests
          // owner approval; the resumed execution itself runs through AgentLoop.
          const context = new (require('../../src/core/execution/execution-context'))({
            requestId: 'request-' + instance.workflowId,
            input: instance.input,
            executionId,
            tenantId: TENANT_ID,
            userId: 'owner-user',
            workspaceId: 'owner-workspace'
          });
          context.start();
          context.transitionAgentTo('planning');
          context.transitionAgentTo('validating');
          context.setPlan(executionPlan);
          context.metadata.planRevision = 1;
          context.metadata.replans = 0;
          context.metadata.pendingStepInputs = {
            1: { tool: 'danger.write', operationId: null }
          };
          context.transitionAgentTo('executing');
          await persistence.checkpoints.save(context.snapshot(), {
            reason: 'approval_waiting',
            tenantId: TENANT_ID
          });
          throw Object.assign(new Error('Explicit owner approval required'), {
            code: 'APPROVAL_REQUIRED',
            executionContext: {
              executionId,
              approvalId: issued.approvalId,
              step: 1,
              planRevision: 1,
              tool: 'danger.write',
              capability: 'external.write'
            }
          });
        }
      })
    });
    await workerService.runOnce();

    let workflow = await persistence.workflows.findById(taskId, TENANT_ID);
    assert.equal(workflow.state, 'WAITING');
    assert.equal(workflow.metadata.taskId, taskId);
    assert.equal(workflow.metadata.approvalBlocked, true);
    const executionId = workflow.metadata.approvalExecutionId;
    const approvalId = workflow.metadata.approvalId;
    assert.equal(executionId, 'execution-' + taskId);
    assert.ok(approvalId);
    assert.equal(workerExecutions, 1);
    assert.equal(workerErrors.length, 0);

    const statusResponse = await request(origin, '/api/v1/tasks/' + encodeURIComponent(taskId), {
      headers: ownerHeaders
    });
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.task.status, 'waiting');
    assert.equal(statusPayload.task.executionId, executionId);
    assert.equal(statusPayload.task.approvalRequired, true);

    const listResponse = await request(origin, '/api/v1/tasks?limit=10&offset=0', {
      headers: ownerHeaders
    });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.items.length, 1);
    assert.equal(listPayload.items[0].id, taskId);
    assert.equal(listPayload.items[0].approvalRequired, true);

    // A fresh scheduler must not re-run a workflow blocked on owner approval.
    const recoveryScheduler = createScheduler(persistence);
    await recoveryScheduler.recoverPersisted('recovery-worker', []);
    assert.equal((await persistence.workflows.findById(taskId, TENANT_ID)).state, 'WAITING');
    assert.equal(workerExecutions, 1);

    // Simulate process restart: drain the worker, close HTTP ingress, shut down
    // the old runtime, and reconstruct Runtime/ApprovalService on the same store.
    await workerService.stopAndDrain();
    await closeServer();
    await runtimeBeforeRestart.shutdown();
    approvalService = new ApprovalService({
      repository: persistence.approvals,
      tenantId: TENANT_ID,
      decisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId)
    });
    runtimeAfterRestart = makeRuntime(approvalService);
    agentService.runtime = runtimeAfterRestart;
    server = createServer({ agentRoutes: createAgentRoutes(agentService), ownerAuth });
    await startServerAndLogin();

    const resumeRoute = '/owner/executions/' + encodeURIComponent(executionId) + '/resume';
    const resumeResponse = await request(origin, resumeRoute, {
      method: 'POST',
      headers: ownerHeaders,
      body: { approval: { approvalId } }
    });
    const resumeText = await resumeResponse.text();
    assert.equal(resumeResponse.status, 200, 'owner resume failed: ' + resumeText);
    const resumePayload = JSON.parse(resumeText);
    assert.equal(resumePayload.execution.executionId, executionId);
    assert.equal(resumePayload.execution.status, 'completed');
    assert.equal(sideEffects, 1);

    workflow = await persistence.workflows.findById(taskId, TENANT_ID);
    assert.equal(workflow.state, 'COMPLETED');
    assert.equal(workflow.metadata.approvalBlocked, false);
    assert.equal(workflow.metadata.approvalDecisionStatus, 'approved');
    const storedApproval = await persistence.approvals.findById(approvalId, { tenantId: TENANT_ID });
    assert.equal(storedApproval.decision.status, 'approved');
    assert.equal(storedApproval.used, true);

    const replayResume = await request(origin, resumeRoute, {
      method: 'POST',
      headers: ownerHeaders,
      body: { approval: { approvalId } }
    });
    assert.equal(replayResume.status, 200);
    assert.equal(sideEffects, 1, 'repeated resume must not replay the external side effect');
    assert.equal(workerExecutions, 1);
  } finally {
    if (workerService) await workerService.stopAndDrain().catch(() => {});
    await closeServer().catch(() => {});
    if (runtimeAfterRestart) await Promise.resolve().then(() => runtimeAfterRestart.shutdown()).catch(() => {});
    if (runtimeBeforeRestart) await Promise.resolve().then(() => runtimeBeforeRestart.shutdown()).catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});


test('owner HTTP approval resume uses reconstructed real Runtime and executes the approved step once', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-owner-real-resume-e2e-'));
  const persistence = new JsonPersistence({ rootDir });
  const ownerAuth = new OwnerAuthService({ password: OWNER_PASSWORD });
  const approvalServiceBeforeRestart = new ApprovalService({
    repository: persistence.approvals,
    tenantId: TENANT_ID,
    decisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId)
  });
  const executionId = 'execution-http-real-resume';
  let workflowId = null;
  const plan = {
    intent: 'resume.approved.operation',
    confidence: 1,
    agentId: 'ORIENT_RUNTIME',
    steps: [{
      step: 1,
      tool: 'danger.write',
      input: { resourceId: 'resource-http-42' },
      dependsOn: null
    }]
  };

  let sideEffects = 0;
  const makeToolRegistry = () => ({
    has: tool => tool === 'danger.write',
    get: tool => ({ name: tool }),
    async execute(tool, input, executionContext) {
      assert.equal(tool, 'danger.write');
      assert.deepEqual(input, { resourceId: 'resource-http-42' });
      assert.match(executionContext.idempotencyKey, /^[a-f0-9]{64}$/);
      assert.equal(executionContext.tenantId, TENANT_ID);
      sideEffects += 1;
      return { receipt: 'owner-approved-provider-operation' };
    }
  });
  const agentOrchestrator = {
    decideReplanning() {
      return { nextAction: null, toJSON: () => ({ outcome: 'done', nextAction: null }) };
    },
    async recover(error) { throw error; }
  };

  let runtimeBeforeRestart;
  let runtimeAfterRestart;
  let server;
  try {
    const issued = await approvalServiceBeforeRestart.issue({
      executionId,
      step: 1,
      planRevision: 1,
      tool: 'danger.write',
      capability: 'external.write',
      scope: { planRevision: 1 },
      tenantId: TENANT_ID,
      ttlMs: 60000
    });

    const context = new (require('../../src/core/execution/execution-context'))({
      requestId: 'request-http-real-resume',
      input: 'perform the owner-approved operation',
      executionId,
      tenantId: TENANT_ID,
      userId: 'owner-user',
      workspaceId: 'owner-workspace'
    });
    context.start();
    context.transitionAgentTo('planning');
    context.transitionAgentTo('validating');
    context.setPlan(plan);
    context.metadata.planRevision = 1;
    context.metadata.replans = 0;
    context.metadata.pendingStepInputs = {
      1: { tool: 'danger.write', operationId: null }
    };
    context.transitionAgentTo('executing');
    await persistence.checkpoints.save(context.snapshot(), {
      reason: 'approval_waiting',
      tenantId: TENANT_ID
    });

    // Persist the corresponding waiting workflow, then reconstruct Runtime as a process restart.
    runtimeBeforeRestart = new (require('../../src/core/runtime/orient-runtime'))({
      tenantId: TENANT_ID,
      userId: 'owner-user',
      workspaceId: 'owner-workspace',
      persistence,
      toolRegistry: makeToolRegistry(),
      agentOrchestrator
    });
    await runtimeBeforeRestart.shutdown();
    const approvalServiceAfterRestart = new ApprovalService({
      repository: persistence.approvals,
      tenantId: TENANT_ID,
      decisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId)
    });
    const authorizationService = {
      approvalService: approvalServiceAfterRestart,
      async assertAuthorized(tool, requestContext) {
        const validation = await approvalServiceAfterRestart.validate({
          approval: requestContext.approval,
          executionId: requestContext.executionId,
          step: requestContext.step,
          planRevision: requestContext.planRevision,
          tool,
          capability: 'external.write',
          scope: { planRevision: requestContext.planRevision },
          tenantId: requestContext.tenantId
        });
        if (!validation.allowed) {
          throw Object.assign(new Error('Approval validation failed'), { code: validation.reason });
        }
        return {
          allowed: true,
          capability: 'external.write',
          risk: 'high',
          requiresApproval: true,
          approval: validation.approval
        };
      }
    };
    const asyncScheduler = createScheduler(persistence);
    runtimeAfterRestart = new (require('../../src/core/runtime/orient-runtime'))({
      tenantId: TENANT_ID,
      userId: 'owner-user',
      workspaceId: 'owner-workspace',
      persistence,
      workflowScheduler: asyncScheduler,
      approvalService: approvalServiceAfterRestart,
      approvalDecisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId),
      authorizationService,
      toolRegistry: makeToolRegistry(),
      agentOrchestrator
    });
    const agentService = new AgentService(runtimeAfterRestart, { taskAcceptanceMode: 'async' });    server = createServer({ agentRoutes: createAgentRoutes(agentService), ownerAuth });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const loginResponse = await request(origin, '/owner/login', {
      method: 'POST',
      headers: { Origin: origin },
      body: { password: OWNER_PASSWORD }
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const loginPayload = await loginResponse.json();
    const ownerHeaders = {
      Origin: origin,
      Cookie: cookie,
      'X-ORIENT-CSRF': loginPayload.csrfToken
    };

    const acceptedTaskResponse = await request(origin, '/api/v1/tasks', {
      method: 'POST',
      headers: { ...ownerHeaders, 'Idempotency-Key': 'real-runtime-approval-task-0001' },
      body: { goal: 'perform the owner-approved operation' }
    });
    const acceptedTaskText = await acceptedTaskResponse.text();
    assert.equal(acceptedTaskResponse.status, 201, 'public async task acceptance failed: ' + acceptedTaskText);
    const acceptedTask = JSON.parse(acceptedTaskText).task;
    workflowId = acceptedTask.id;
    assert.equal(acceptedTask.workflowId, workflowId);
    assert.equal(acceptedTask.status, 'queued');

    // Simulate the worker's durable approval pause after public task acceptance.
    const persistedWorkflow = await persistence.workflows.findById(workflowId, TENANT_ID);
    assert.ok(persistedWorkflow, 'public task must be durably stored before approval pause');
    const workflow = require('../../src/core/workflow/workflow-instance').fromJSON(persistedWorkflow);
    workflow.transition('RUNNING');
    workflow.transition('WAITING');
    workflow.metadata = {
      ...workflow.metadata,
      taskId: workflowId,
      approvalBlocked: true,
      approvalExecutionId: executionId,
      approvalId: issued.approvalId
    };
    await persistence.workflows.save(workflow, TENANT_ID);

    const waitingTaskResponse = await request(origin, '/api/v1/tasks/' + encodeURIComponent(workflowId), {
      headers: ownerHeaders
    });
    assert.equal(waitingTaskResponse.status, 200);
    const waitingTask = (await waitingTaskResponse.json()).task;
    assert.equal(waitingTask.id, workflowId);
    assert.equal(waitingTask.status, 'waiting');
    assert.equal(waitingTask.executionId, executionId);
    assert.equal(waitingTask.approvalRequired, true);

    const resumeResponse = await request(
      origin,
      '/owner/executions/' + encodeURIComponent(executionId) + '/resume',
      {
        method: 'POST',
        headers: ownerHeaders,
        body: { approval: { approvalId: issued.approvalId } }
      }
    );
    const resumeText = await resumeResponse.text();
    assert.equal(resumeResponse.status, 200, 'real Runtime resume failed: ' + resumeText);
    const payload = JSON.parse(resumeText);
    assert.equal(payload.execution.status, 'completed');
    assert.equal(sideEffects, 1);

    const completedTaskResponse = await request(origin, '/api/v1/tasks/' + encodeURIComponent(workflowId), {
      headers: ownerHeaders
    });
    assert.equal(completedTaskResponse.status, 200);
    const completedTask = (await completedTaskResponse.json()).task;
    assert.equal(completedTask.id, workflowId);
    assert.equal(completedTask.status, 'completed');
    assert.equal(completedTask.approvalRequired, false);

    const storedApproval = await persistence.approvals.findById(issued.approvalId, { tenantId: TENANT_ID });
    assert.equal(storedApproval.decision.status, 'approved');
    assert.equal(storedApproval.used, true);

    const reconciledWorkflow = await persistence.workflows.findById(workflowId, TENANT_ID);
    assert.equal(reconciledWorkflow.state, 'COMPLETED');
    assert.equal(reconciledWorkflow.metadata.approvalBlocked, false);
    assert.equal(reconciledWorkflow.metadata.approvalDecisionStatus, 'approved');

    const replayResponse = await request(
      origin,
      '/owner/executions/' + encodeURIComponent(executionId) + '/resume',
      {
        method: 'POST',
        headers: ownerHeaders,
        body: { approval: { approvalId: issued.approvalId } }
      }
    );
    assert.equal(replayResponse.status, 200);
    assert.equal(sideEffects, 1, 'repeated owner resume must not replay the external side effect');
  } finally {
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (runtimeAfterRestart) await Promise.resolve().then(() => runtimeAfterRestart.shutdown()).catch(() => {});
    if (runtimeBeforeRestart) await Promise.resolve().then(() => runtimeBeforeRestart.shutdown()).catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
