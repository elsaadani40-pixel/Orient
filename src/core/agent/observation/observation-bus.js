class ObservationBus {
  constructor() {
    this.listeners = new Map();
  }

  subscribe(event, handler) {
    if (!event || typeof handler !== 'function') {
      throw new TypeError('Invalid observation listener');
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event).add(handler);

    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  async publish(event, data = {}) {
    const handlers = this.listeners.get(event) || [];

    for (const handler of handlers) {
      await handler(data);
    }
  }
}

module.exports = ObservationBus;
