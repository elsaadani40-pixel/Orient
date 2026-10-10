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

test('public async task API survives restart, pauses for approval, and resumes the same execution exactly once', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-async-task-e2e-'));
  const persistence = new JsonPersistence({ rootDir });
  const ownerAuth = new OwnerAuthService({ password: OWNER_PASSWORD });
  const approvalService = new ApprovalService({
    repository: persistence.approvals,
    tenantId: TENANT_ID,
    decisionAuthorizer: ({ actorId }) => ownerAuth.isActiveSession(actorId)
  });

  let coordinator = createCoordinator(createScheduler(persistence), persistence);
  let canonicalExecutionId = null;
  let approvalId = null;
  let workerExecutions = 0;
  let sideEffects = 0;
  const completedExecutions = new Set();
  const workerErrors = [];

  const runtime = {
    tenantId: TENANT_ID,
    persistence,
    workflowExecutionCoordinator: coordinator,
    async execute() { assert.fail('async task submission must not execute inline'); },
    async getExecutionStatus() { assert.fail('async status must be read from workflow state'); },
    async listExecutionSummaries() { return { executions: [], limit: 20, offset: 0, total: 0 }; },
    async decideApproval(options) { return approvalService.decide(options); }
  };

  const agentService = new AgentService(runtime, { taskAcceptanceMode: 'async' });
  const server = createServer({ agentRoutes: createAgentRoutes(agentService), ownerAuth });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
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
  const workerServices = [];

  const createWorkerService = scheduler => {
    const service = new AsyncWorkflowWorkerService({
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
          canonicalExecutionId = 'execution-' + instance.workflowId;
          const issued = await approvalService.issue({
            executionId: canonicalExecutionId,
            step: 1,
            planRevision: 1,
            tool: 'danger.write',
            capability: 'external.write',
            tenantId: TENANT_ID,
            ttlMs: 60000
          });
          approvalId = issued.approvalId;
          throw Object.assign(new Error('Explicit owner approval required'), {
            code: 'APPROVAL_REQUIRED',
            executionContext: {
              executionId: canonicalExecutionId,
              approvalId,
              step: 1,
              planRevision: 1,
              tool: 'danger.write',
              capability: 'external.write'
            }
          });
        }
      })
    });
    workerServices.push(service);
    return service;
  };

  runtime.resume = async (executionId, options = {}) => {
    if (executionId !== canonicalExecutionId) {
      throw Object.assign(new Error('Resume must target the canonical execution'), {
        code: 'APPROVAL_EXECUTION_MISMATCH'
      });
    }
    if (completedExecutions.has(executionId)) {
      return { resumed: false, reason: 'execution_already_terminal', execution: { executionId, status: 'completed' } };
    }
    const approval = await approvalService.getApprovedForExecution({
      approvalId: options.approval?.approvalId,
      executionId,
      tenantId: TENANT_ID
    });
    if (!approval) throw Object.assign(new Error('Durable approval required'), { code: 'APPROVAL_NOT_APPROVED' });
    const validation = await approvalService.validate({
      approval: { approvalId: approval.approvalId },
      executionId,
      step: 1,
      planRevision: 1,
      tool: 'danger.write',
      capability: 'external.write',
      tenantId: TENANT_ID
    });
    if (!validation.allowed) throw Object.assign(new Error('Approval validation failed'), { code: validation.reason });
    const consumed = await approvalService.consume(approval.approvalId, new Date().toISOString(), TENANT_ID);
    if (!consumed) throw Object.assign(new Error('Approval consume failed'), { code: 'APPROVAL_CONSUME_FAILED' });
    sideEffects += 1;
    completedExecutions.add(executionId);
    const result = {
      resumed: true,
      execution: { executionId, status: 'completed', completedAt: new Date().toISOString() },
      result: { committed: true }
    };
    await coordinator.reconcileApprovalResume(executionId, result);
    return result;
  };

    const acceptedResponse = await request(origin, '/api/v1/tasks', {
      method: 'POST',
      headers: { ...ownerHeaders, 'Idempotency-Key': 'async-e2e-request-0001' },
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
      headers: { 'Idempotency-Key': 'async-e2e-request-0001' },
      body: { goal: 'perform the protected operation' }
    });
    assert.equal(replayResponse.status, 200);
    const replayPayload = await replayResponse.json();
    assert.equal(replayPayload.replayed, true);
    assert.deepEqual(replayPayload.task, acceptedPayload.task);

    // Replace the in-memory scheduler/coordinator as if the process restarted.
    coordinator = createCoordinator(createScheduler(persistence), persistence);
    runtime.workflowExecutionCoordinator = coordinator;
    await createWorkerService(coordinator.scheduler).runOnce();

    let workflow = await persistence.workflows.findById(taskId, TENANT_ID);
    assert.equal(workflow.state, 'WAITING');
    assert.equal(workflow.metadata.taskId, taskId);
    assert.equal(workflow.metadata.approvalBlocked, true);
    assert.equal(workflow.metadata.approvalExecutionId, canonicalExecutionId);
    assert.equal(workflow.metadata.approvalId, approvalId);
    assert.equal(workerExecutions, 1);
    assert.equal(workerErrors.length, 0);

    const statusResponse = await request(origin, '/api/v1/tasks/' + encodeURIComponent(taskId), { headers: ownerHeaders });
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.task.status, 'waiting');
    assert.equal(statusPayload.task.executionId, canonicalExecutionId);
    assert.equal(statusPayload.task.approvalRequired, true);

    const listResponse = await request(origin, '/api/v1/tasks?limit=10&offset=0', { headers: ownerHeaders });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.items.length, 1);
    assert.equal(listPayload.items[0].id, taskId);
    assert.equal(listPayload.items[0].executionId, canonicalExecutionId);
    assert.equal(listPayload.items[0].approvalRequired, true);

    // Generic recovery after the approval pause must not re-execute the step.
    const recoveryCoordinator = createCoordinator(createScheduler(persistence), persistence);
    runtime.workflowExecutionCoordinator = recoveryCoordinator;
    await createWorkerService(recoveryCoordinator.scheduler).runOnce();
    workflow = await persistence.workflows.findById(taskId, TENANT_ID);
    assert.equal(workflow.state, 'WAITING');
    assert.equal(workerExecutions, 1);

    const resumeRoute = '/owner/executions/' + encodeURIComponent(canonicalExecutionId) + '/resume';
    const resumeHeaders = ownerHeaders;
    const resumeResponse = await request(origin, resumeRoute, {
      method: 'POST',
      headers: resumeHeaders,
      body: { approval: { approvalId } }
    });
    assert.equal(resumeResponse.status, 200);
    const resumePayload = await resumeResponse.json();
    assert.equal(resumePayload.execution.executionId, canonicalExecutionId);
    assert.equal(resumePayload.execution.status, 'completed');
    assert.equal(sideEffects, 1);

    workflow = await persistence.workflows.findById(taskId, TENANT_ID);
    assert.equal(workflow.state, 'COMPLETED');
    assert.equal(workflow.metadata.approvalBlocked, false);
    assert.equal(workflow.metadata.approvalDecisionStatus, 'approved');

    const replayResume = await request(origin, resumeRoute, {
      method: 'POST',
      headers: resumeHeaders,
      body: { approval: { approvalId } }
    });
    assert.equal(replayResume.status, 200);
    assert.equal(sideEffects, 1);
    assert.equal(workerExecutions, 1);
  } finally {
    for (const service of workerServices) await service.stopAndDrain().catch(() => {});
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
