class AgentEventStore {
  constructor() {
    this.events = [];
  }

  append(event) {
    if (!event || !event.type) {
      throw new TypeError('Invalid agent event');
    }

    this.events.push(event);

    return event;
  }

  list({ executionId = null, goalId = null } = {}) {
    return this.events.filter((event) => {
      if (executionId && event.executionId !== executionId) {
        return false;
      }

      if (goalId && event.goalId !== goalId) {
        return false;
      }

      return true;
    });
  }

  clear() {
    this.events = [];
  }
}

module.exports = AgentEventStore;
