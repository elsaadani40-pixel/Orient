'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ChannelAdapter = require('../../../../src/interfaces/channels/channel-adapter');

function createAdapter({ authenticate, runtimeForPrincipal, maxMessageChars } = {}) {
  return new ChannelAdapter({
    channelId: 'web.chat',
    authenticate: authenticate || (async () => ({ subject: 'user-1', tenant: 'tenant-1' })),
    runtimeForPrincipal: runtimeForPrincipal || (() => ({ async execute(message) { return { message }; } })),
    ...(maxMessageChars === undefined ? {} : { maxMessageChars })
  });
}

test('channel adapter authenticates sender and dispatches only to that principal scoped Runtime', async () => {
  const calls = [];
  const principal = Object.freeze({ subject: 'verified-user', tenant: 'verified-tenant' });
  const runtime = {
    async execute(...args) {
      calls.push(args);
      return { requestId: 'runtime-request-1', type: 'result' };
    }
  };
  let authenticatedEnvelope;
  let resolvedPrincipal;
  const adapter = createAdapter({
    authenticate: async envelope => {
      authenticatedEnvelope = envelope;
      return principal;
    },
    runtimeForPrincipal: async value => {
      resolvedPrincipal = value;
      return runtime;
    }
  });

  const response = await adapter.receive({
    message: '  summarize my notes  ',
    tenantId: 'attacker-tenant',
    userId: 'attacker-user',
    approval: { allowed: true },
    approvals: { highRisk: true }
  });

  assert.equal(authenticatedEnvelope.userId, 'attacker-user'); // Passed only for provider verification.
  assert.equal(resolvedPrincipal, principal);
  assert.deepEqual(calls, [['summarize my notes']]);
  assert.deepEqual(response, {
    channelId: 'web.chat',
    result: { requestId: 'runtime-request-1', type: 'result' }
  });
  assert.equal(Object.isFrozen(response), true);
});

test('channel adapter rejects invalid configuration', () => {
  const validRuntimeResolver = () => ({ execute() {} });
  assert.throws(() => new ChannelAdapter({ channelId: 'Web Chat', authenticate() {}, runtimeForPrincipal: validRuntimeResolver }), /channelId/);
  assert.throws(() => new ChannelAdapter({ channelId: 'web.chat', runtimeForPrincipal: validRuntimeResolver }), /authenticator/);
  assert.throws(() => new ChannelAdapter({ channelId: 'web.chat', authenticate() {} }), /Runtime resolver/);
  assert.throws(() => new ChannelAdapter({ channelId: 'web.chat', authenticate() {}, runtimeForPrincipal: validRuntimeResolver, maxMessageChars: 0 }), /maxMessageChars/);
});

test('channel adapter rejects malformed, empty, and non-text messages before authentication', async () => {
  let authCalls = 0;
  const adapter = createAdapter({ authenticate: async () => { authCalls += 1; return { subject: 'user-1' }; } });

  await assert.rejects(() => adapter.receive(null), error => error.code === 'CHANNEL_ENVELOPE_INVALID');
  await assert.rejects(() => adapter.receive([]), error => error.code === 'CHANNEL_ENVELOPE_INVALID');
  await assert.rejects(() => adapter.receive({ message: { text: 'hello' } }), error => error.code === 'CHANNEL_MESSAGE_INVALID');
  await assert.rejects(() => adapter.receive({ message: '  ' }), error => error.code === 'CHANNEL_MESSAGE_EMPTY');
  assert.equal(authCalls, 0);
});

test('channel adapter enforces inbound message size limit before authentication', async () => {
  let authCalls = 0;
  const adapter = createAdapter({
    maxMessageChars: 4,
    authenticate: async () => { authCalls += 1; return { subject: 'user-1' }; }
  });

  await assert.rejects(
    () => adapter.receive({ message: '12345' }),
    error => error.code === 'CHANNEL_MESSAGE_TOO_LARGE'
  );
  assert.equal(authCalls, 0);
});

test('channel adapter fails closed for unauthenticated senders and never resolves a Runtime', async () => {
  let resolveCalls = 0;
  const adapter = createAdapter({
    authenticate: async () => null,
    runtimeForPrincipal: async () => { resolveCalls += 1; return { async execute() {} }; }
  });

  await assert.rejects(
    () => adapter.receive({ message: 'do something' }),
    error => error.code === 'CHANNEL_UNAUTHENTICATED'
  );
  assert.equal(resolveCalls, 0);
});

test('channel adapter fails closed when no principal-scoped Runtime is available', async () => {
  const adapter = createAdapter({ runtimeForPrincipal: async () => null });
  await assert.rejects(
    () => adapter.receive({ message: 'do something' }),
    error => error.code === 'CHANNEL_RUNTIME_UNAVAILABLE'
  );
});

test('channel adapter propagates authentication failures without invoking a Runtime', async () => {
  let resolveCalls = 0;
  const adapter = createAdapter({
    authenticate: async () => { throw new Error('invalid provider signature'); },
    runtimeForPrincipal: async () => { resolveCalls += 1; return { async execute() {} }; }
  });

  await assert.rejects(() => adapter.receive({ message: 'do something' }), /invalid provider signature/);
  assert.equal(resolveCalls, 0);
});
