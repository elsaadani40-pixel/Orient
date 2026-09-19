class ExecutionRepositoryInterface {
  findAll() {
    throw new Error('ExecutionRepository.findAll() must be implemented');
  }

  findById() {
    throw new Error('ExecutionRepository.findById() must be implemented');
  }

  findByGoalId() {
    throw new Error('ExecutionRepository.findByGoalId() must be implemented');
  }

  insert() {
    throw new Error('ExecutionRepository.insert() must be implemented');
  }

  update() {
    throw new Error('ExecutionRepository.update() must be implemented');
  }

  deleteById() {
    throw new Error('ExecutionRepository.deleteById() must be implemented');
  }

  count() {
    throw new Error('ExecutionRepository.count() must be implemented');
  }
}

module.exports = ExecutionRepositoryInterface;
