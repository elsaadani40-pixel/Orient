'use strict';

/**
 * Inbound adapter boundary for external communication channels.
 *
 * A channel adapter may normalize an untrusted message, but it must not
 * execute tools, construct approval decisions, or choose Runtime identity.
 * Runtime identity and authorization remain configured by the host.
 */
class ChannelAdapter {
  constructor({ channelId, runtime, maxMessageChars = 100000 } = {}) {
    if (typeof channelId !== 'string' ||
        !/^[a-z][a-z0-9._-]{0,63}$/.test(channelId)) {
      throw new TypeError('channelId must be a stable lowercase identifier');
    }
    if (!runtime || typeof runtime.execute !== 'function') {
      throw new TypeError('A compatible ORIENT Runtime is required');
    }
    if (!Number.isSafeInteger(maxMessageChars) ||
        maxMessageChars < 1 || maxMessageChars > 1000000) {
      throw new RangeError('maxMessageChars must be between 1 and 1000000');
    }

    this.channelId = channelId;
    this.runtime = runtime;
    this.maxMessageChars = maxMessageChars;
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

    // Deliberately forward only the normalized message. Never trust channel
    // payloads to select tenant/user identity or inject approvals/options.
    const result = await this.runtime.execute(message);
    return Object.freeze({
      channelId: this.channelId,
      result
    });
  }
}

module.exports = ChannelAdapter;
