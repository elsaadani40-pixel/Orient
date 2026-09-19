const path = require('path');

const ExecutionRepository = require('./json/execution.repository');
const EventRepository = require('./json/event.repository');
const IdempotencyRepository = require('./json/idempotency.repository');

class JsonPersistence {
  constructor({ dataDirectory } = {}) {
    this.dataDirectory =
      dataDirectory ||
      path.join(process.cwd(), 'data', 'agent');

    this.executions = new ExecutionRepository(
      path.join(this.dataDirectory, 'executions.json')
    );

    this.events = new EventRepository(
      path.join(this.dataDirectory, 'events.json')
    );

    this.idempotency = new IdempotencyRepository(
      path.join(this.dataDirectory, 'idempotency.json')
    );
  }

  health() {
    return {
      adapter: 'json',
      ready: true,
      dataDirectory: this.dataDirectory,
      repositories: {
        executions: true,
        events: true,
        idempotency: true
      }
    };
  }
}

module.exports = JsonPersistence;
