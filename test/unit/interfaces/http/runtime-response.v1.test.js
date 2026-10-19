'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  API_VERSION,
  createRuntimeResponseV1,
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_EVIDENCE_REFERENCES
} = require('../../../../src/interfaces/http/contracts/runtime-response.v1');

test('creates a versioned response without inventing an assistant answer', () => {
  assert.deepEqual(createRuntimeResponseV1({
    taskId: 'task-123',
    status: 'running'
  }), {
    apiVersion: 'v1',
    assistant: { text: null },
    task: { id: 'task-123', status: 'running' },
    evidenceReferences: [],
    approvalRequired: false
  });
  assert.equal(API_VERSION, 'v1');
});

test('preserves an actual Runtime answer and bounded evidence references', () => {
  const response = createRuntimeResponseV1({
    assistantText: 'تم التحقق من النتيجة.',
    taskId: 'task-123',
    status: 'completed',
    evidenceReferences: [{ id: 'event-4', type: 'runtime.event', label: 'نتيجة التنفيذ' }],
    approvalRequired: true
  });
  assert.equal(response.assistant.text, 'تم التحقق من النتيجة.');
  assert.equal(response.evidenceReferences[0].id, 'event-4');
  assert.equal(response.approvalRequired, true);
  assert.ok(Object.isFrozen(response));
  assert.ok(Object.isFrozen(response.task));
  assert.ok(Object.isFrozen(response.evidenceReferences));
});

test('rejects missing, oversized, or control-character task identifiers', () => {
  for (const taskId of [undefined, '', 'x'.repeat(201), 'task\nforged']) {
    assert.throws(() => createRuntimeResponseV1({ taskId, status: 'queued' }), { code: 'RUNTIME_RESPONSE_INVALID' });
  }
});

test('rejects unknown Runtime status instead of silently normalizing it', () => {
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'success-ish' }), /status/);
});

test('rejects invalid or oversized assistant text', () => {
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'completed', assistantText: 42 }), /assistantText/);
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'completed', assistantText: 'x'.repeat(MAX_ASSISTANT_TEXT_CHARS + 1) }), /assistantText/);
});

test('rejects malformed or excessive evidence references', () => {
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'completed', evidenceReferences: [null] }), /object/);
  assert.throws(() => createRuntimeResponseV1({
    taskId: 't1',
    status: 'completed',
    evidenceReferences: Array.from({ length: MAX_EVIDENCE_REFERENCES + 1 }, (_, i) => ({ id: String(i), type: 'runtime.event' }))
  }), /bounded array/);
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'completed', evidenceReferences: [{ id: 'e1', type: 'BAD TYPE' }] }), /type/);
});

test('rejects non-boolean approval state and malformed evidence labels', () => {
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'queued', approvalRequired: 'yes' }), /boolean/);
  assert.throws(() => createRuntimeResponseV1({ taskId: 't1', status: 'completed', evidenceReferences: [{ id: 'e1', type: 'runtime.event', label: 'bad\nlabel' }] }), /label/);
});
