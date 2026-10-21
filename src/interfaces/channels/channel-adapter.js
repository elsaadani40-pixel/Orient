'use strict';

/**
 * Authenticated ingress boundary for external communication channels.
 *
 * The channel payload is untrusted. A host-supplied authenticator must derive
 * the principal from trusted provider credentials/signatures, not payload
 * identity fields. A host-supplied resolver must return the Runtime scoped to
 * that authenticated principal. This adapter never grants approvals or tools.
 */
class ChannelAdapter {
  constructor({
    channelId,
    authenticate,
    runtimeForPrincipal,
    sanitizeResult,
    maxMessageChars = 100000,
    maxResponseChars = 10000
  } = {}) {
    if (typeof channelId !== 'string' ||
        !/^[a-z][a-z0-9._-]{0,63}$/.test(channelId)) {
      throw new TypeError('channelId must be a stable lowercase identifier');
    }
    if (typeof authenticate !== 'function') {
      throw new TypeError('A trusted channel authenticator is required');
    }
    if (typeof runtimeForPrincipal !== 'function') {
      throw new TypeError('A principal-scoped Runtime resolver is required');
    }
    if (typeof sanitizeResult !== 'function') {
      throw new TypeError('A trusted outbound result sanitizer is required');
    }
    if (!Number.isSafeInteger(maxResponseChars) || maxResponseChars < 1 || maxResponseChars > 100000) {
      throw new RangeError('maxResponseChars must be between 1 and 100000');
    }
    if (!Number.isSafeInteger(maxMessageChars) ||
        maxMessageChars < 1 || maxMessageChars > 1000000) {
      throw new RangeError('maxMessageChars must be between 1 and 1000000');
    }

    this.channelId = channelId;
    this.authenticate = authenticate;
    this.runtimeForPrincipal = runtimeForPrincipal;
    this.sanitizeResult = sanitizeResult;
    this.maxMessageChars = maxMessageChars;
    this.maxResponseChars = maxResponseChars;
    Object.freeze(this);
  }

  async receive(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw Object.assign(new TypeError('Inbound envelope must be an object'), {
        code: 'CHANNEL_ENVELOPE_INVALID'
      });
    }

    if (typeof envelope.message !== 'string') {
      throw Object.assign(new TypeError('Inbound message must be text'), {
        code: 'CHANNEL_MESSAGE_INVALID'
      });
    }

    const message = envelope.message.trim();
    if (!message) {
      throw Object.assign(new TypeError('Inbound message must not be empty'), {
        code: 'CHANNEL_MESSAGE_EMPTY'
      });
    }
    if (message.length > this.maxMessageChars) {
      throw Object.assign(new RangeError('Inbound message exceeds the channel limit'), {
        code: 'CHANNEL_MESSAGE_TOO_LARGE'
      });
    }

    // Authentication must verify trusted provider credentials/signatures.
    // Caller-supplied userId/tenantId fields are never used as identity.
    const principal = await this.authenticate(envelope, { channelId: this.channelId });
    if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
      throw Object.assign(new Error('Inbound sender is not authenticated'), {
        code: 'CHANNEL_UNAUTHENTICATED'
      });
    }

    const runtime = await this.runtimeForPrincipal(principal);
    if (!runtime || typeof runtime.execute !== 'function') {
      throw Object.assign(new Error('No Runtime is available for this principal'), {
        code: 'CHANNEL_RUNTIME_UNAVAILABLE'
      });
    }

    const rawResult = await runtime.execute(message);
    const result = await this.sanitizeResult(rawResult);
    if (typeof result !== 'string' || !result.trim()) {
      throw Object.assign(new TypeError('Sanitized channel response must be non-empty text'), {
        code: 'CHANNEL_RESPONSE_INVALID'
      });
    }
    if (result.length > this.maxResponseChars) {
      throw Object.assign(new RangeError('Sanitized channel response exceeds the channel limit'), {
        code: 'CHANNEL_RESPONSE_TOO_LARGE'
      });
    }
    return Object.freeze({ channelId: this.channelId, result: result.trim() });
  }
}

module.exports = ChannelAdapter;
