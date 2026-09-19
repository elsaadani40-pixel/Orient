const OBSERVATION_EVENTS = require('./observation-events');

class EventStoreSubscriber {
  constructor({ observationBus, eventStore } = {}) {
    if (!observationBus) {
      throw new TypeError('observationBus is required');
    }

    if (!eventStore) {
      throw new TypeError('eventStore is required');
    }

    this.observationBus = observationBus;
    this.eventStore = eventStore;
    this.unsubscribe = [];
  }

  start() {
    if (this.unsubscribe.length > 0) {
      return this;
    }

    for (const event of Object.values(OBSERVATION_EVENTS)) {
      const unsubscribe = this.observationBus.subscribe(
        event,
        (payload) => this.eventStore.append(payload)
      );

      this.unsubscribe.push(unsubscribe);
    }

    return this;
  }

  stop() {
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }

    this.unsubscribe = [];

    return this;
  }
}

module.exports = EventStoreSubscriber;
