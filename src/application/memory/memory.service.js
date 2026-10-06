const AppError = require('../../core/errors/AppError');
const {
  createMemory,
  normalizeMemory
} = require('../../domain/memory/memory.entity');

class MemoryService {
  constructor(repository, {
    memoryAccessPolicy = null,
    defaultScope = 'personal'
  } = {}) {
    this.repository = repository;
    this.memoryAccessPolicy = memoryAccessPolicy;
    this.defaultScope = defaultScope;
  }

  authorize(context = {}, operation = 'read', scope = this.defaultScope) {
    if (!this.memoryAccessPolicy) {
      return null;
    }

    return this.memoryAccessPolicy.authorize({
      agentId: context.agentId || 'ORIENT_RUNTIME',
      scope: context.memoryScope || scope,
      operation
    });
  }

  tenantId(context = {}) {
    return context.tenantId || 'local';
  }

  list(query = '', context = {}) {
    this.authorize(context, 'read');

    const memories = this.repository
      .findAll(this.tenantId(context))
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

  add(text, options = {}, context = {}) {
    this.authorize(context, 'write');

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

      return this.repository.insert(memory, this.tenantId(context));
    } catch (error) {
      throw new AppError(
        error.message,
        400,
        'INVALID_MEMORY'
      );
    }
  }

  get(id, context = {}) {
    this.authorize(context, 'read');

    const memory = this.repository.findById(
      id,
      this.tenantId(context)
    );

    if (!memory) {
      throw new AppError(
        'الذاكرة غير موجودة',
        404,
        'MEMORY_NOT_FOUND'
      );
    }

    return normalizeMemory(memory);
  }

  delete(id, context = {}) {
    this.authorize(context, 'write');

    const cleanId = String(id || '').trim();

    if (!cleanId) {
      throw new AppError(
        'معرّف الذاكرة مطلوب',
        400,
        'MEMORY_ID_REQUIRED'
      );
    }

    const deleted = this.repository.deleteById(
      cleanId,
      this.tenantId(context)
    );

    if (!deleted) {
      throw new AppError(
        'الذاكرة غير موجودة',
        404,
        'MEMORY_NOT_FOUND'
      );
    }

    return true;
  }

  count(context = {}) {
    this.authorize(context, 'read');
    return this.repository.findAll(this.tenantId(context)).length;
  }
}

module.exports = MemoryService;
