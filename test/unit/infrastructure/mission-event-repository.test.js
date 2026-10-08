const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventRepository = require('../../../src/infrastructure/persistence/json/event.repository');

test('mission events receive durable per-aggregate sequence under the repository lock', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-mission-events-'));
  const repository = new EventRepository(path.join(directory, 'events.json'));

  const first = repository.appendMissionEvent({
    id: 'm1',
    aggregateId: 'wf-1',
    type: 'workflow.created',
    data: {}
  });
  const second = repository.appendMissionEvent({
    id: 'm2',
    aggregateId: 'wf-1',
    type: 'workflow.state.changed',
    data: { to: 'QUEUED' }
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(repository.findByAggregateId('wf-1').map(event => event.sequence), [1, 2]);

  assert.throws(
    () => repository.appendMissionEvent({
      id: 'm3',
      aggregateId: 'wf-1',
      sequence: 9,
      type: 'workflow.state.changed',
      data: { to: 'RUNNING' }
    }),
    error => error.code === 'MISSION_EVENT_SEQUENCE_CONFLICT'
  );

  fs.rmSync(directory, { recursive: true, force: true });
});
