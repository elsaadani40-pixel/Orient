'use strict';

const net = require('node:net');

function validateLocalBaseUrl(value) {
  const rawUrl = String(value);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(
      new TypeError('Ollama baseUrl must be a valid loopback URL'),
      { code: 'MODEL_PROVIDER_INVALID_URL' }
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const authority = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] || '';
  const rawHostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const rawHostname = rawHostPort.startsWith('[')
    ? rawHostPort.slice(1, rawHostPort.indexOf(']'))
    : rawHostPort.split(':')[0];
  const ipVersion = net.isIP(rawHostname);
  // Do not accept URL-parser shorthand (integer, octal, or hex IPv4 forms):
  // only the exact host token supplied by the caller may establish locality.
  const isLoopback =
    (ipVersion === 4 && rawHostname === hostname && rawHostname.split('.')[0] === '127') ||
    (ipVersion === 6 && rawHostname.toLowerCase() === '::1' && hostname === '::1');

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !isLoopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw Object.assign(
      new Error('Ollama provider is local-only; remote or ambiguous base URLs are denied'),
      { code: 'MODEL_PROVIDER_REMOTE_URL_DENIED' }
    );
  }

  return url.toString().replace(/\/$/, '');
}

class OllamaProvider {
  constructor({
    id = 'ollama.local',
    baseUrl = 'http://127.0.0.1:11434',
    model = 'llama3.2:3b',
    timeoutMs = 60000,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetch is required');
    }

    this.id = id;
    this.baseUrl = validateLocalBaseUrl(baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.capabilities = ['text-generation', 'chat'];
    this.costClass = 'free';
    this.locality = 'local';
  }

  async complete(request = {}) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs
    );

    try {
      const response = await this.fetch(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: request.model || this.model,
            messages: Array.isArray(request.messages)
              ? request.messages
              : [{ role: 'user', content: String(request.input || '') }],
            stream: false,
            options: request.options || undefined
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        throw Object.assign(
          new Error(`Ollama request failed with HTTP ${response.status}`),
          { code: 'MODEL_PROVIDER_REQUEST_FAILED' }
        );
      }

      const payload = await response.json();
      const text = payload?.message?.content;

      if (typeof text !== 'string') {
        throw Object.assign(
          new Error('Ollama returned no model content'),
          { code: 'MODEL_PROVIDER_INVALID_RESPONSE' }
        );
      }

      return {
        text,
        provider: this.id,
        model: request.model || this.model,
        usage: payload.usage || null
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(
          new Error('Ollama request timed out'),
          { code: 'MODEL_PROVIDER_TIMEOUT' }
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = OllamaProvider;
