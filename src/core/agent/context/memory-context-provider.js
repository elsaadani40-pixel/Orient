class MemoryContextProvider {
  constructor(memoryService) {
    if (!memoryService) {
      throw new TypeError('memoryService is required');
    }

    this.memoryService = memoryService;
  }

  async provide({ query = '' } = {}) {
    const memories = this.memoryService.list(
      String(query || '').trim()
    );

    return {
      source: 'memory',
      query: String(query || '').trim(),
      memories
    };
  }
}

module.exports = MemoryContextProvider;
