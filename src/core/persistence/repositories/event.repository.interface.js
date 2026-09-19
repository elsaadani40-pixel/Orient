class EventRepositoryInterface {
  findAll() {
    throw new Error('EventRepository.findAll() must be implemented');
  }

  findByExecutionId() {
    throw new Error('EventRepository.findByExecutionId() must be implemented');
  }

  findByGoalId() {
    throw new Error('EventRepository.findByGoalId() must be implemented');
  }

  findByType() {
    throw new Error('EventRepository.findByType() must be implemented');
  }

  append() {
    throw new Error('EventRepository.append() must be implemented');
  }

  appendMany() {
    throw new Error('EventRepository.appendMany() must be implemented');
  }

  count() {
    throw new Error('EventRepository.count() must be implemented');
  }

  clear() {
    throw new Error('EventRepository.clear() must be implemented');
  }
}

module.exports = EventRepositoryInterface;
