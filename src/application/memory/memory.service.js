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
    if (!repository) {
      throw new TypeError('repository is required');
    }

    this.repository = repository;
    this.memoryAccessPolicy = memoryAccessPolicy;
    this.defaultScope = defaultScope;
  }

  resolveTenant(context = {}) {
    const tenantId = context.tenantId;

    if (!tenantId || typeof tenantId !== 'string') {
      throw new AppError(
        'Tenant identity is required for memory access',
        403,
        'MEMORY_TENANT_REQUIRED'
      );
    }

    if (
      context.runtimeTenantId &&
      context.runtimeTenantId !== tenantId
    ) {
      throw new AppError(
        'Memory tenant does not match canonical runtime tenant',
        403,
        'MEMORY_TENANT_CONTEXT_MISMATCH'
      );
    }

    return tenantId;
  }

  resolveScope(context = {}, requestedScope = null) {
    const scope =
      requestedScope ||
      context.memoryScope ||
      this.defaultScope;

    if (!scope || typeof scope !== 'string') {
      throw new AppError(
        'Memory scope is required',
        403,
        'MEMORY_SCOPE_REQUIRED'
      );
    }

    return scope;
  }

  authorize(context = {}, operation = 'read', scope = null) {
    const tenantId = this.resolveTenant(context);
    const resolvedScope = this.resolveScope(context, scope);

    if (!this.memoryAccessPolicy) {
      return {
        allowed: true,
        agentId: context.agentId || 'ORIENT_RUNTIME',
        scope: resolvedScope,
        operation,
        tenantId
      };
    }

    const decision = this.memoryAccessPolicy.authorize({
      agentId: context.agentId || 'ORIENT_RUNTIME',
      scope: resolvedScope,
      operation
    });

    return Object.freeze({
      ...decision,
      tenantId
    });
  }

  list(query = '', context = {}) {
    const authorization = this.authorize(context, 'read');

    const memories = this.repository
      .findAll(authorization.tenantId, authorization.scope)
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
    const requestedScope =
      options &&
      typeof options === 'object'
        ? options.scope
        : null;

    const authorization = this.authorize(
      context,
      'write',
      requestedScope
    );

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
        importance: options.importance,
        scope: authorization.scope
      });

      return this.repository.insert(
        memory,
        authorization.tenantId,
        authorization.scope
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        error.message,
        400,
        'INVALID_MEMORY'
      );
    }
  }

  get(id, context = {}) {
    const authorization = this.authorize(context, 'read');

    const memory = this.repository.findById(
      id,
      authorization.tenantId,
      authorization.scope
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
    const authorization = this.authorize(context, 'delete');

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
      authorization.tenantId,
      authorization.scope
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
    const authorization = this.authorize(context, 'read');

    return this.repository.findAll(
      authorization.tenantId,
      authorization.scope
    ).length;
  }
}

module.exports = MemoryService;
