const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventRepository = require('../../../../src/infrastructure/persistence/json/event.repository');
const WorkflowRepository = require('../../../../src/infrastructure/persistence/json/workflow.repository');
const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');
const DurableMissionEventSink = require('../../../../src/core/workflow/durable-mission-event-sink');
const MissionEventRecovery = require('../../../../src/core/workflow/mission-event-recovery');

function make() {
  return new WorkflowInstance({ workflowId: 'step-38-mission', tenantId: 'tenant-a', definition: new WorkflowDefinition({
    id: 'step-38', version: 1, name: 'Step 38', steps: [{ id: 'work', tool: 'work' }]
  }) });
}
function stores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-step38-'));
  return { dir, events: new EventRepository(path.join(dir, 'events.json')), workflows: new WorkflowRepository(path.join(dir, 'workflows.json')) };
}

async function seed(s) {
  const sink = new DurableMissionEventSink({ eventRepository: s.events, workflowRepository: s.workflows });
  const mission = make();
  await sink.recordCreated(mission);
  mission.transition('QUEUED');
  await sink.recordState(mission, 'CREATED', 'QUEUED');
  return mission;
}

test('reconciles snapshot behind durable event stream and repairs checkpoint', async () => {
  const s = stores();
  const mission = await seed(s);
  const before = s.workflows.findById(mission.workflowId, 'tenant-a');
  assert.equal(before.checkpoint.revision, 1);
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  const result = await recovery.reconcile(mission.workflowId, 'tenant-a');
  assert.equal(result.status, 'REPAIRED');
  assert.equal(result.workflow.state, 'QUEUED');
  assert.equal(s.workflows.findById(mission.workflowId, 'tenant-a').checkpoint.revision, 2);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('rejects snapshot ahead of durable event history', async () => {
  const s = stores();
  const mission = await seed(s);
  const snapshot = s.workflows.findById(mission.workflowId, 'tenant-a');
  snapshot.checkpoint.revision = 99;
  fs.writeFileSync(s.workflows.filePath, JSON.stringify([snapshot]) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  await assert.rejects(() => recovery.reconcile(mission.workflowId, 'tenant-a'), e => e.code === 'MISSION_SNAPSHOT_AHEAD_OF_EVENTS');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('rebuilds a semantically corrupt snapshot from valid event history', async () => {
  const s = stores();
  const mission = await seed(s);
  const snapshot = s.workflows.findById(mission.workflowId, 'tenant-a');
  snapshot.state = 'NOT_A_STATE';
  fs.writeFileSync(s.workflows.filePath, JSON.stringify([snapshot]) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  await assert.rejects(() => recovery.reconcile(mission.workflowId, 'tenant-a'), e => e.code === 'MISSION_SNAPSHOT_CORRUPT');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('detects missing event sequence and refuses silent repair', async () => {
  const s = stores();
  await seed(s);
  const all = s.events.read();
  all[1].sequence = 3;
  fs.writeFileSync(s.events.filePath, JSON.stringify(all) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  await assert.rejects(() => recovery.reconcile('step-38-mission', 'tenant-a'), e => e.code === 'MISSION_EVENT_SEQUENCE_GAP');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('preserves tenant and aggregate boundaries during recovery', async () => {
  const s = stores();
  await seed(s);
  const snapshot = s.workflows.findById('step-38-mission', 'tenant-a');
  snapshot.tenantId = 'tenant-b';
  fs.writeFileSync(s.workflows.filePath, JSON.stringify([snapshot]) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  await assert.rejects(() => recovery.reconcile('step-38-mission', 'tenant-a'), e => e.code === 'WORKFLOW_CHECKPOINT_CONFLICT');
  assert.equal(s.workflows.findById('step-38-mission', 'tenant-a'), null);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('duplicate event replay remains idempotent', async () => {
  const s = stores();
  await seed(s);
  const events = s.events.findByAggregateId('step-38-mission', { tenantId: 'tenant-a' });
  const Projection = require('../../../../src/core/workflow/mission-event-projection');
  const projected = new Projection().rebuild([...events, events[1]]);
  assert.equal(projected.state, 'QUEUED');
  assert.equal(projected.metadata.projection.lastSequence, 2);
  fs.rmSync(s.dir, { recursive: true, force: true });
});


test('mission recovery awaits asynchronous event, snapshot, and repair repositories', async () => {
  const s = stores();
  const mission = await seed(s);
  const calls = [];
  const asyncEvents = {
    async findByAggregateId(...args) {
      await Promise.resolve();
      calls.push('events');
      return s.events.findByAggregateId(...args);
    }
  };
  const asyncWorkflows = {
    async findById(...args) {
      await Promise.resolve();
      calls.push('snapshot');
      return s.workflows.findById(...args);
    },
    async repair(...args) {
      await Promise.resolve();
      calls.push('repair');
      return s.workflows.repair(...args);
    }
  };
  const recovery = new MissionEventRecovery({
    eventRepository: asyncEvents,
    workflowRepository: asyncWorkflows
  });
  const result = await recovery.reconcile(mission.workflowId, 'tenant-a');
  assert.equal(result.status, 'REPAIRED');
  assert.deepEqual(calls, ['events', 'snapshot', 'repair']);
  fs.rmSync(s.dir, { recursive: true, force: true });
});


test('does not downgrade a checkpointed workflow with missing events to legacy recovery', async () => {
  const s = stores();
  const mission = await seed(s);
  assert.ok(s.workflows.findById(mission.workflowId, 'tenant-a').checkpoint.revision > 0);
  s.events.write([]);
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });

  await assert.rejects(
    () => recovery.reconcile(mission.workflowId, 'tenant-a'),
    error => error.code === 'MISSION_EVENT_HISTORY_MISSING'
  );
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('recognizes an uncheckpointed snapshot without events as a legacy workflow', async () => {
  const s = stores();
  const mission = make();
  fs.writeFileSync(s.workflows.filePath, JSON.stringify([mission.toJSON()]) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });

  await assert.rejects(
    () => recovery.reconcile(mission.workflowId, 'tenant-a'),
    error => error.code === 'MISSION_EVENT_HISTORY_REQUIRED'
  );
  fs.rmSync(s.dir, { recursive: true, force: true });
});
