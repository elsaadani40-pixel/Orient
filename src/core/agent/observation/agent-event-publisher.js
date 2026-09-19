const AgentEvent = require('./agent-event');

class AgentEventPublisher {
  constructor(observationBus) {
    if (!observationBus) {
      throw new TypeError('observationBus is required');
    }

    this.observationBus = observationBus;
  }

  async publish({
    type,
    executionId = null,
    goalId = null,
    data = {}
  } = {}) {
    const event = new AgentEvent({
      type,
      executionId,
      goalId,
      data
    });

    await this.observationBus.publish(
      type,
      event
    );

    return event;
  }
}

module.exports = AgentEventPublisher;
