'use strict';

const API_VERSION = 'v1';
const TASK_STATUSES = new Set([
  'created', 'queued', 'pending', 'running', 'paused', 'awaiting_approval',
  'completed', 'failed', 'cancelled', 'rejected'
]);
const MAX_ASSISTANT_TEXT_CHARS = 20000;
const MAX_EVIDENCE_REFERENCES = 100;
const MAX_ID_CHARS = 200;

function invalid(message, code = 'RUNTIME_RESPONSE_INVALID') {
  return Object.assign(new TypeError(message), { code });
}

function createRuntimeResponseV1({
  assistantText = null,
  assistantStatus = null,
  taskId,
  status,
  evidenceReferences = [],
  approvalRequired = false
} = {}) {
  if (typeof taskId !== 'string' || taskId.length < 1 || taskId.length > MAX_ID_CHARS || /[\r\n\0]/.test(taskId)) {
    throw invalid('taskId must be a bounded, non-empty identifier.');
  }
  if (typeof status !== 'string' || !TASK_STATUSES.has(status)) {
    throw invalid('status is not a supported Runtime task status.');
  }
  if (assistantText !== null && (typeof assistantText !== 'string' || assistantText.length > MAX_ASSISTANT_TEXT_CHARS)) {
    throw invalid('assistantText must be null or a bounded string.');
  }
  const resolvedAssistantStatus = assistantStatus || (typeof assistantText === 'string' && assistantText.trim() ? 'available' : status === 'completed' ? 'unavailable' : 'pending');
  if (!['pending', 'available', 'unavailable'].includes(resolvedAssistantStatus)) {
    throw invalid('assistantStatus must be pending, available, or unavailable.');
  }
  if (resolvedAssistantStatus === 'available' && (typeof assistantText !== 'string' || !assistantText.trim())) {
    throw invalid('available assistant status requires non-empty assistant text.');
  }
  if (resolvedAssistantStatus !== 'available' && assistantText !== null) {
    throw invalid('assistant text must be null unless assistant status is available.');
  }
  if (!Array.isArray(evidenceReferences) || evidenceReferences.length > MAX_EVIDENCE_REFERENCES) {
    throw invalid('evidenceReferences must be a bounded array.');
  }
  const safeEvidence = evidenceReferences.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid('Each evidence reference must be an object.');
    }
    const { id, type, label = null } = item;
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_CHARS || /[\r\n\0]/.test(id)) {
      throw invalid('Evidence reference id is invalid.');
    }
    if (typeof type !== 'string' || !/^[a-z][a-z0-9._-]{0,49}$/.test(type)) {
      throw invalid('Evidence reference type is invalid.');
    }
    if (label !== null && (typeof label !== 'string' || label.length > 200 || /[\r\n\0]/.test(label))) {
      throw invalid('Evidence reference label is invalid.');
    }
    return Object.freeze({ id, type, label });
  });
  if (typeof approvalRequired !== 'boolean') {
    throw invalid('approvalRequired must be a boolean.');
  }

  return Object.freeze({
    apiVersion: API_VERSION,
    assistant: Object.freeze({ text: assistantText, status: resolvedAssistantStatus }),
    task: Object.freeze({ id: taskId, status }),
    evidenceReferences: Object.freeze(safeEvidence),
    approvalRequired
  });
}

module.exports = {
  API_VERSION,
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_EVIDENCE_REFERENCES,
  createRuntimeResponseV1
};
