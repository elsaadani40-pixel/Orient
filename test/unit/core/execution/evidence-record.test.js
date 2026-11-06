'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, createEvidenceRecord, verifyEvidenceRecord } = require('../../../../src/core/execution/evidence-record');
const ExecutionContext = require('../../../../src/core/execution/execution-context');

test('canonical JSON sorts object keys and preserves array order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, b: 2 }, list: [3, 1] }),
    '{"a":{"b":2,"y":true},"list":[3,1],"z":1}'
  );
});

test('canonical JSON rejects cycles and non-JSON values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /circular reference/);
  assert.throws(() => canonicalJson({ value: undefined }), /non-JSON value/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite number/);
});

test('evidence identity is content-addressed and independent of object key insertion order', () => {
  const common = {
    executionId: 'execution-1',
    step: 2,
    tool: 'memory.search',
    success: true,
    observedAt: '2026-11-06T12:00:00.000Z'
  };
  const first = createEvidenceRecord({ ...common, result: { a: 1, b: 2 } });
  const second = createEvidenceRecord({ ...common, result: { b: 2, a: 1 } });

  assert.equal(first.id, second.id);
  assert.match(first.id, /^ev_[a-f0-9]{64}$/);
  assert.match(first.resultSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.confidence, 'observed');
  assert.equal(first.authority, 'our_run');
  assert.deepEqual(first.coverage, { status: 'unknown' });
  assert.equal(Object.hasOwn(first, 'result'), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(verifyEvidenceRecord(first), true);
});

test('evidence verification detects modified records and invalid digests', () => {
  const evidence = createEvidenceRecord({
    executionId: 'execution-integrity',
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'completed' },
    observedAt: '2026-11-06T12:00:00.000Z'
  });

  assert.equal(verifyEvidenceRecord(evidence), true);
  assert.equal(verifyEvidenceRecord({ ...evidence, outcome: 'failure' }), false);
  assert.equal(verifyEvidenceRecord({ ...evidence, id: 'ev_' + '0'.repeat(64) }), false);
});

test('unsupported result data is explicitly marked instead of being treated as verified', () => {
  const record = createEvidenceRecord({
    executionId: 'execution-2',
    step: 1,
    tool: 'tool.inspect',
    success: true,
    result: { capturedAt: new Date() },
    observedAt: '2026-11-06T12:00:00.000Z'
  });

  assert.equal(record.resultSha256, null);
  assert.equal(record.limitations[0].code, 'result_digest_unavailable');
});

test('execution observations carry evidence metadata without duplicating raw result content', () => {
  const execution = new ExecutionContext({
    requestId: 'request-1',
    executionId: 'execution-3',
    input: 'inspect status'
  });

  execution.addObservation({
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'completed', privatePayload: 'do-not-copy' }
  });

  const observation = execution.observations[0];
  assert.equal(observation.evidence.executionId, 'execution-3');
  assert.equal(observation.evidence.step, 1);
  assert.equal(observation.evidence.operation, 'execution.get');
  assert.equal(observation.evidence.outcome, 'success');
  assert.equal(observation.evidence.resultSha256.length, 64);
  assert.equal(JSON.stringify(observation.evidence).includes('do-not-copy'), false);
  assert.equal(execution.snapshot().observations[0].evidence.id, observation.evidence.id);
  assert.equal(execution.agentState.observations[0].evidence.id, observation.evidence.id);

  const restored = ExecutionContext.restore(execution.snapshot());
  assert.equal(restored.observations[0].evidence.id, observation.evidence.id);
  assert.equal(verifyEvidenceRecord(restored.observations[0].evidence), true);

  const tamperedSnapshot = structuredClone(execution.snapshot());
  tamperedSnapshot.observations[0].evidence.outcome = 'failure';
  assert.throws(
    () => ExecutionContext.restore(tamperedSnapshot),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );

  const tamperedAgentSnapshot = structuredClone(execution.snapshot());
  tamperedAgentSnapshot.agentState.observations[0].evidence.operation = 'execution.delete';
  assert.throws(
    () => ExecutionContext.restore(tamperedAgentSnapshot),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );
});

test('failed observations preserve a bounded error code in their evidence record', () => {
  const execution = new ExecutionContext({
    requestId: 'request-2',
    executionId: 'execution-4',
    input: 'inspect status'
  });

  execution.addObservation({
    step: 1,
    tool: 'execution.get',
    success: false,
    error: { code: 'UPSTREAM_UNAVAILABLE', message: 'sensitive upstream detail' }
  });

  const evidence = execution.observations[0].evidence;
  assert.equal(evidence.outcome, 'failure');
  assert.equal(evidence.errorCode, 'UPSTREAM_UNAVAILABLE');
  assert.equal(JSON.stringify(evidence).includes('sensitive upstream detail'), false);
});
