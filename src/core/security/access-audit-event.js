'use strict';

const { randomUUID } = require('node:crypto');

const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ROUTES = [
  [/^\/$/, '/'],
  [/^\/dashboard$/, '/dashboard'],
  [/^\/command-scene\.js$/, '/command-scene.js'],
  [/^\/agent$/, '/agent'],
  [/^\/memory\/(add|delete)$/, '/memory/:operation'],
  [/^\/executions$/, '/executions'],
  [/^\/executions\/[^/]+\/events$/, '/executions/:id/events'],
  [/^\/executions\/[^/]+\/approvals$/, '/executions/:id/approvals'],
  [/^\/executions\/[^/]+\/cancel$/, '/executions/:id/cancel'],
  [/^\/executions\/[^/]+\/resume$/, '/executions/:id/resume'],
  [/^\/executions\/[^/]+$/, '/executions/:id'],
  [/^\/approvals\/pending$/, '/approvals/pending']
];

function sanitizeText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, maxLength);
}

function routeTemplate(pathname) {
  const path = sanitizeText(pathname, 512);
  const match = ROUTES.find(([pattern]) => pattern.test(path));
  return match ? match[1] : '/_unmatched';
}

function normalizeIp(value) {
  const ip = sanitizeText(value, 64).trim();
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function createAccessAuditEvent({
  requestId = randomUUID(),
  timestamp = new Date().toISOString(),
  sourceIp,
  method,
  pathname,
  statusCode,
  userAgent,
  durationMs
} = {}) {
  const numericStatus = Number(statusCode);
  const numericDuration = Number(durationMs);

  return Object.freeze({
    schemaVersion: 1,
    eventId: randomUUID(),
    requestId: sanitizeText(requestId, 80),
    timestamp: new Date(timestamp).toISOString(),
    sourceIp: normalizeIp(sourceIp),
    method: SAFE_METHODS.has(String(method || '').toUpperCase())
      ? String(method).toUpperCase()
      : 'OTHER',
    route: routeTemplate(pathname),
    statusCode: Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
      ? numericStatus
      : 0,
    userAgent: sanitizeText(userAgent, 160),
    durationMs: Number.isFinite(numericDuration) && numericDuration >= 0
      ? Math.min(Math.floor(numericDuration), 86400000)
      : 0,
    authenticationOutcome: 'not_evaluated'
  });
}

module.exports = { createAccessAuditEvent, routeTemplate, normalizeIp };
