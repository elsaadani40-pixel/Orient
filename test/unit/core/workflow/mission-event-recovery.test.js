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
  const result = recovery.reconcile(mission.workflowId, 'tenant-a');
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
  assert.throws(() => recovery.reconcile(mission.workflowId, 'tenant-a'), e => e.code === 'MISSION_SNAPSHOT_AHEAD_OF_EVENTS');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('rebuilds a semantically corrupt snapshot from valid event history', async () => {
  const s = stores();
  const mission = await seed(s);
  const snapshot = s.workflows.findById(mission.workflowId, 'tenant-a');
  snapshot.state = 'NOT_A_STATE';
  fs.writeFileSync(s.workflows.filePath, JSON.stringify([snapshot]) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  assert.throws(() => recovery.reconcile(mission.workflowId, 'tenant-a'), e => e.code === 'MISSION_SNAPSHOT_CORRUPT');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('detects missing event sequence and refuses silent repair', async () => {
  const s = stores();
  await seed(s);
  const all = s.events.read();
  all[1].sequence = 3;
  fs.writeFileSync(s.events.filePath, JSON.stringify(all) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  assert.throws(() => recovery.reconcile('step-38-mission', 'tenant-a'), e => e.code === 'MISSION_EVENT_SEQUENCE_GAP');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('preserves tenant and aggregate boundaries during recovery', async () => {
  const s = stores();
  await seed(s);
  const snapshot = s.workflows.findById('step-38-mission', 'tenant-a');
  snapshot.tenantId = 'tenant-b';
  fs.writeFileSync(s.workflows.filePath, JSON.stringify([snapshot]) + '\n');
  const recovery = new MissionEventRecovery({ eventRepository: s.events, workflowRepository: s.workflows });
  assert.throws(() => recovery.reconcile('step-38-mission', 'tenant-a'), e => e.code === 'MISSION_SNAPSHOT_TENANT_MISMATCH');
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

test('JSON workflow repository lists only bounded pending publications for the requested tenant', () => {
  const s = stores();
  const first = make();
  first.metadata = { approvalBlocked: true, pendingPublications: [{ eventId: 'pending-a' }] };
  const other = new WorkflowInstance({
    workflowId: 'step-38-other-tenant', tenantId: 'tenant-b',
    definition: new WorkflowDefinition({ id: 'step-38-other', version: 1, name: 'Other', steps: [{ id: 'work', tool: 'work' }] })
  });
  other.metadata = { approvalBlocked: true, pendingPublications: [{ eventId: 'pending-b' }] };
  s.workflows.save(first, 'tenant-a');
  s.workflows.save(other, 'tenant-b');
  const pending = s.workflows.findPendingPublications({ tenantId: 'tenant-a', limit: 1 });
  assert.deepEqual(pending.map(item => item.workflowId), [first.workflowId]);
  const staleSnapshot = WorkflowInstance.fromJSON(s.workflows.findById(first.workflowId, 'tenant-a'));
  const ack = s.workflows.acknowledgePendingPublications(first.workflowId, 'tenant-a', ['pending-a']);
  assert.equal(ack.acknowledged, 1);
  assert.equal(ack.revision, staleSnapshot.checkpoint.revision + 1);
  assert.deepEqual(s.workflows.findPendingPublications({ tenantId: 'tenant-a' }), []);
  assert.throws(
    () => s.workflows.save(staleSnapshot, 'tenant-a'),
    error => error.code === 'WORKFLOW_CHECKPOINT_CONFLICT'
  );
  fs.rmSync(s.dir, { recursive: true, force: true });
});
