const AppError = require('../../core/errors/AppError');
const {
  createMemory,
  normalizeMemory
} = require('../../domain/memory/memory.entity');

class MemoryService {
  constructor(repository) {
    this.repository = repository;
  }

  list(query = '') {
    const memories = this.repository
      .findAll()
      .map(normalizeMemory);

    const cleanQuery = String(query || '')
      .trim()
      .toLowerCase();

    if (!cleanQuery) {
      return memories;
    }

    return memories.filter(memory =>
      memory.text.toLowerCase().includes(cleanQuery)
    );
  }

  add(text, options = {}) {
    const clean = String(text || '').trim();

    if (!clean) {
      throw new AppError(
        'نص الذاكرة مطلوب',
        400,
        'MEMORY_TEXT_REQUIRED'
      );
    }

    try {
      const memory = createMemory({
        text: clean,
        type: options.type,
        importance: options.importance
      });

      return this.repository.insert(memory);
    } catch (error) {
      throw new AppError(
        error.message,
        400,
        'INVALID_MEMORY'
      );
    }
  }

  get(id) {
    const memory = this.repository.findById(id);

    if (!memory) {
      throw new AppError(
        'الذاكرة غير موجودة',
        404,
        'MEMORY_NOT_FOUND'
      );
    }

    return normalizeMemory(memory);
  }

  delete(id) {
    const cleanId = String(id || '').trim();

    if (!cleanId) {
      throw new AppError(
        'معرّف الذاكرة مطلوب',
        400,
        'MEMORY_ID_REQUIRED'
      );
    }

    const deleted = this.repository.deleteById(cleanId);

    if (!deleted) {
      throw new AppError(
        'الذاكرة غير موجودة',
        404,
        'MEMORY_NOT_FOUND'
      );
    }

    return true;
  }

  count() {
    return this.repository.findAll().length;
  }
}

module.exports = MemoryService;
