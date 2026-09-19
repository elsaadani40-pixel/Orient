class IdempotencyRepositoryInterface {
  buildKey() {
    throw new Error('IdempotencyRepository.buildKey() must be implemented');
  }

  findByKey() {
    throw new Error('IdempotencyRepository.findByKey() must be implemented');
  }

  find() {
    throw new Error('IdempotencyRepository.find() must be implemented');
  }

  begin() {
    throw new Error('IdempotencyRepository.begin() must be implemented');
  }

  complete() {
    throw new Error('IdempotencyRepository.complete() must be implemented');
  }

  fail() {
    throw new Error('IdempotencyRepository.fail() must be implemented');
  }

  delete() {
    throw new Error('IdempotencyRepository.delete() must be implemented');
  }

  clear() {
    throw new Error('IdempotencyRepository.clear() must be implemented');
  }

  count() {
    throw new Error('IdempotencyRepository.count() must be implemented');
  }
}

module.exports = IdempotencyRepositoryInterface;
