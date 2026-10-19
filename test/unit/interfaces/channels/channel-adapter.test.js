'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ChannelAdapter = require('../../../../src/interfaces/channels/channel-adapter');

test('channel adapter forwards normalized text only through the canonical Runtime', async () => {
  const calls = [];
  const runtime = {
    async execute(...args) {
      calls.push(args);
      return { requestId: 'runtime-request-1', type: 'result' };
    }
  };
  const adapter = new ChannelAdapter({ channelId: 'web.chat', runtime });

  const response = await adapter.receive({
    message: '  summarize my notes  ',
    tenantId: 'attacker-tenant',
    userId: 'attacker-user',
    approval: { allowed: true },
    approvals: { highRisk: true }
  });

  assert.deepEqual(calls, [['summarize my notes']]);
  assert.deepEqual(response, {
    channelId: 'web.chat',
    result: { requestId: 'runtime-request-1', type: 'result' }
  });
  assert.equal(Object.isFrozen(response), true);
});

test('channel adapter rejects invalid runtime and channel identifiers', () => {
  assert.throws(() => new ChannelAdapter({ channelId: 'Web Chat', runtime: { execute() {} } }), /channelId/);
  assert.throws(() => new ChannelAdapter({ channelId: 'web.chat', runtime: {} }), /Runtime/);
  assert.throws(() => new ChannelAdapter({ channelId: 'web.chat', runtime: { execute() {} }, maxMessageChars: 0 }), /maxMessageChars/);
});

test('channel adapter rejects malformed, empty, and non-text messages without calling Runtime', async () => {
  let calls = 0;
  const adapter = new ChannelAdapter({
    channelId: 'voice.inbound',
    runtime: { async execute() { calls += 1; } }
  });

  await assert.rejects(() => adapter.receive(null), error => error.code === 'CHANNEL_ENVELOPE_INVALID');
  await assert.rejects(() => adapter.receive([]), error => error.code === 'CHANNEL_ENVELOPE_INVALID');
  await assert.rejects(() => adapter.receive({ message: { text: 'hello' } }), error => error.code === 'CHANNEL_MESSAGE_INVALID');
  await assert.rejects(() => adapter.receive({ message: '  ' }), error => error.code === 'CHANNEL_MESSAGE_EMPTY');
  assert.equal(calls, 0);
});

test('channel adapter enforces its inbound message size limit', async () => {
  let calls = 0;
  const adapter = new ChannelAdapter({
    channelId: 'mobile.sms',
    maxMessageChars: 4,
    runtime: { async execute() { calls += 1; } }
  });

  await assert.rejects(
    () => adapter.receive({ message: '12345' }),
    error => error.code === 'CHANNEL_MESSAGE_TOO_LARGE'
  );
  assert.equal(calls, 0);
});
