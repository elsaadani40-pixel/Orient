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

test('canonical JSON rejects sparse arrays, array extensions, symbols, and accessors', () => {
  const sparse = new Array(1);
  assert.throws(() => canonicalJson(sparse), /sparse arrays/);

  const extended = [1];
  extended.extra = 2;
  assert.throws(() => canonicalJson(extended), /extra properties/);

  const symbolKeyed = { value: 1 };
  symbolKeyed[Symbol('hidden')] = 2;
  assert.throws(() => canonicalJson(symbolKeyed), /symbol keys/);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unstable';
    }
  });
  assert.throws(() => canonicalJson(accessor), /accessors/);
  assert.equal(getterCalls, 0);
});

test('canonical JSON enforces its byte limit while producing output', () => {
  assert.throws(
    () => canonicalJson({ value: 'x'.repeat(2 * 1024 * 1024) }),
    /maximum canonical size/
  );
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

test('versioned snapshots require complete matching evidence in context and AgentState', () => {
  const execution = new ExecutionContext({
    requestId: 'request-versioned',
    executionId: 'execution-versioned',
    input: 'verify persisted observations'
  });
  execution.addObservation({
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'completed' }
  });
  execution.addObservation({
    step: 2,
    tool: 'memory.search',
    success: true,
    result: { count: 3 }
  });

  const snapshot = execution.snapshot();
  assert.equal(snapshot.evidenceSchemaVersion, 1);
  assert.equal(
    ExecutionContext.restore(snapshot).agentState.observations.length,
    2
  );

  const missingAgentEvidence = structuredClone(snapshot);
  delete missingAgentEvidence.agentState.observations[0].evidence;
  assert.throws(
    () => ExecutionContext.restore(missingAgentEvidence),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );

  const missingAgentObservation = structuredClone(snapshot);
  missingAgentObservation.agentState.observations.pop();
  assert.throws(
    () => ExecutionContext.restore(missingAgentObservation),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );

  const mismatchedAgentObservation = structuredClone(snapshot);
  mismatchedAgentObservation.agentState.observations[0].id = 'different-observation';
  assert.throws(
    () => ExecutionContext.restore(mismatchedAgentObservation),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );

  const missingContextEvidence = structuredClone(snapshot);
  delete missingContextEvidence.observations[0].evidence;
  assert.throws(
    () => ExecutionContext.restore(missingContextEvidence),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );

  const unsupportedVersion = structuredClone(snapshot);
  unsupportedVersion.evidenceSchemaVersion = 2;
  assert.throws(
    () => ExecutionContext.restore(unsupportedVersion),
    error => error.code === 'EXECUTION_EVIDENCE_INTEGRITY_FAILED'
  );
});

test('legacy snapshots without evidence remain restorable', () => {
  const execution = new ExecutionContext({
    requestId: 'request-legacy',
    executionId: 'execution-legacy',
    input: 'restore historical execution'
  });
  execution.addObservation({
    step: 1,
    tool: 'execution.get',
    success: true,
    result: { status: 'completed' }
  });

  const legacySnapshot = structuredClone(execution.snapshot());
  delete legacySnapshot.evidenceSchemaVersion;
  delete legacySnapshot.observations[0].evidence;
  delete legacySnapshot.agentState.observations[0].evidence;

  const restored = ExecutionContext.restore(legacySnapshot);
  assert.equal(restored.observations.length, 1);
  assert.equal(restored.observations[0].evidence, undefined);
  assert.equal(restored.agentState.observations.length, 1);
  assert.equal(restored.agentState.observations[0].evidence, undefined);
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
