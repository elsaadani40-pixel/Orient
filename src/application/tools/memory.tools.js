const ToolInterface = require('../../core/tools/tool.interface');

function createMemoryTools(memoryService) {
  const searchMemory = new ToolInterface({
    name: 'memory.search',
    description: 'البحث داخل ذاكرة ORIENT ONE',
    execute: async (input, context) => {
      const query = String(input || '').trim();

      return {
        query,
        memories: memoryService.list(query, context),
      };
    },
  });

  const listMemory = new ToolInterface({
    name: 'memory.list',
    description: 'عرض الذكريات المحفوظة',
    execute: async (input, context) => {
      return {
        memories: memoryService.list('', context),
      };
    },
  });

  const addMemory = new ToolInterface({
    name: 'memory.add',
    description: 'إضافة معلومة جديدة إلى ذاكرة ORIENT ONE',
    execute: async (input, context) => {
      const text =
        typeof input === 'string'
          ? input
          : input && input.text;

      return memoryService.add(text, input && typeof input === 'object'
        ? input
        : {}, context);
    },
    reconcile: async (input, recoveryContext = {}) =>
      memoryService.reconcileToolOperation('memory.add', input, {
        ...recoveryContext,
        tenantId: recoveryContext.tenantId || recoveryContext.record?.tenantId,
        memoryScope: input?.scope || recoveryContext.memoryScope || 'personal'
      }),
  });

  const memoryHistory = new ToolInterface({
    name: 'memory.history',
    description: 'عرض سجل التدقيق والقرارات المرتبطة بذاكرة ORIENT ONE',
    execute: async (input, context) => {
      const id =
        typeof input === 'string'
          ? input
          : input && input.id;

      return {
        memoryId: id,
        history: memoryService.history(id, context),
      };
    },
  });

  const deleteMemory = new ToolInterface({
    name: 'memory.delete',
    description: 'حذف معلومة من ذاكرة ORIENT ONE',
    execute: async (input, context) => {
      const id =
        typeof input === 'string'
          ? input
          : input && input.id;

      return memoryService.delete(id, context);
    },
    reconcile: async (input, recoveryContext = {}) =>
      memoryService.reconcileToolOperation('memory.delete', input, {
        ...recoveryContext,
        tenantId: recoveryContext.tenantId || recoveryContext.record?.tenantId,
        memoryScope: recoveryContext.memoryScope || input?.scope || 'personal'
      }),
  });

  return [
    searchMemory,
    listMemory,
    addMemory,
    deleteMemory,
    memoryHistory,
  ];
}

module.exports = createMemoryTools;
