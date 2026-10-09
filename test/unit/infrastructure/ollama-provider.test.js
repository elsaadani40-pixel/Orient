const test = require('node:test');
const assert = require('node:assert/strict');

const OllamaProvider = require('../../../src/infrastructure/model/ollama.provider');

test('OllamaProvider sends a local chat request and returns normalized text', async () => {
  let request = null;

  const provider = new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          message: { content: '{"intent":"memory.search","steps":[]}' }
        })
      };
    }
  });

  const result = await provider.complete({
    input: 'test'
  });

  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.equal(result.text, '{"intent":"memory.search","steps":[]}');
  assert.equal(result.provider, 'ollama.local');
});

test('OllamaProvider converts HTTP failures into provider errors', async () => {
  const provider = new OllamaProvider({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({})
    })
  });

  await assert.rejects(
    () => provider.complete({ input: 'test' }),
    error => error.code === 'MODEL_PROVIDER_REQUEST_FAILED'
  );
});

test('OllamaProvider refuses remote URLs so remote inference cannot masquerade as local', () => {
  for (const baseUrl of [
    'https://example.com',
    'http://192.168.1.20:11434',
    'http://user:pass@127.0.0.1:11434',
    'http://127.0.0.1:11434?redirect=https://example.com',
    'file:///tmp/ollama'
  ]) {
    assert.throws(
      () => new OllamaProvider({ baseUrl, fetchImpl: async () => ({}) }),
      error => [
        'MODEL_PROVIDER_REMOTE_URL_DENIED',
        'MODEL_PROVIDER_INVALID_URL'
      ].includes(error.code),
      baseUrl
    );
  }
});

test('OllamaProvider accepts explicit loopback IPv4, IPv6, and localhost endpoints', () => {
  for (const baseUrl of [
    'http://127.0.0.2:11434',
    'http://[::1]:11434',
    'http://localhost:11434'
  ]) {
    assert.doesNotThrow(
      () => new OllamaProvider({ baseUrl, fetchImpl: async () => ({}) }),
      baseUrl
    );
  }
});
