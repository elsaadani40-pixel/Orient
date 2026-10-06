const path = require('path');
const ExecutionRepository = require('./execution.repository');
const EventRepository = require('./event.repository');
const IdempotencyRepository = require('./idempotency.repository');
const CheckpointRepository = require('./checkpoint.repository');
const WorkflowRepository = require('./workflow.repository');
const WorkflowLeaseRepository = require('./workflow-lease.repository');

class JsonPersistence {
  constructor({ rootDir } = {}) {
    if (!rootDir) throw new TypeError('rootDir is required');
    this.rootDir = path.resolve(rootDir);
    this.executions = new ExecutionRepository(path.join(this.rootDir, 'executions.json'));
    this.events = new EventRepository(path.join(this.rootDir, 'events.json'));
    this.idempotency = new IdempotencyRepository(path.join(this.rootDir, 'idempotency.json'));
    this.checkpoints = new CheckpointRepository(path.join(this.rootDir, 'checkpoints.json'));
    this.workflows = new WorkflowRepository(path.join(this.rootDir, 'workflows.json'));
    this.workflowLeases = new WorkflowLeaseRepository(path.join(this.rootDir, 'workflow-leases.json'));
  }
}
module.exports = JsonPersistence;
