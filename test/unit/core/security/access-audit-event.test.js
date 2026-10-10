'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccessAuditEvent, routeTemplate } = require('../../../../src/core/security/access-audit-event');

test('access audit events store route templates rather than execution identifiers', () => {
  const event = createAccessAuditEvent({
    requestId: 'request-1',
    sourceIp: '127.0.0.1',
    method: 'get',
    pathname: '/executions/private-id/events',
    statusCode: 200,
    userAgent: 'unit-test',
    durationMs: 2.9
  });
  assert.equal(event.route, '/executions/:id/events');
  assert.equal(event.sourceIp, '127.0.0.1');
  assert.equal(event.method, 'GET');
  assert.equal(event.statusCode, 200);
  assert.equal(event.durationMs, 2);
  assert.equal(event.authenticationOutcome, 'not_evaluated');
});

test('audit events omit query strings and bound client-controlled fields', () => {
  const event = createAccessAuditEvent({
    sourceIp: '',
    method: 'TRACE',
    pathname: '/unknown?token=not-logged',
    statusCode: 999,
    userAgent: 'x'.repeat(500),
    durationMs: -1
  });
  assert.equal(event.sourceIp, 'unknown');
  assert.equal(event.method, 'OTHER');
  assert.equal(event.route, '/_unmatched');
  assert.equal(event.statusCode, 0);
  assert.equal(event.durationMs, 0);
  assert.equal(event.userAgent.length, 160);
  assert.equal(JSON.stringify(event).includes('not-logged'), false);
  assert.equal(routeTemplate('/executions/private-id/cancel'), '/executions/:id/cancel');
});
