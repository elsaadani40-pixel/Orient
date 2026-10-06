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
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
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
