'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemory } = require('../../src/domain/memory/memory.entity');
const { conflictResolutionScore } = require('../../src/application/memory/memory.service');

function memoryWithEvidence(evidence) {
  return createMemory({
    text: 'The owner prefers Arabic',
    source: { type: 'user', id: 'owner' },
    confidence: 0.8,
    evidence,
    tenantId: 'tenant-a',
    scope: 'personal'
  });
}

test('replaying the same evidence ID does not increase evidence strength', () => {
  const evidence = {
    id: 'source-event-123',
    kind: 'observation',
    source: { type: 'user', id: 'owner' },
    capturedAt: '2026-10-17T10:00:00.000Z',
    confidence: 0.9,
    note: 'User explicitly stated preference'
  };

  const oneCopy = memoryWithEvidence([evidence]);
  const repeatedCopy = memoryWithEvidence([evidence, evidence, evidence]);

  const oneScore = conflictResolutionScore(oneCopy).components.evidence;
  const repeatedScore = conflictResolutionScore(repeatedCopy).components.evidence;

  assert.equal(repeatedScore, oneScore);
});

test('distinct evidence IDs retain the independent-evidence bonus', () => {
  const first = {
    id: 'source-event-123',
    source: { type: 'user', id: 'owner' },
    confidence: 0.9
  };
  const second = {
    id: 'source-event-456',
    source: { type: 'user', id: 'owner' },
    confidence: 0.9
  };

  const oneScore = conflictResolutionScore(memoryWithEvidence([first])).components.evidence;
  const twoScore = conflictResolutionScore(memoryWithEvidence([first, second])).components.evidence;

  assert.ok(twoScore > oneScore);
});
