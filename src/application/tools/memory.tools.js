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
  });

  return [
    searchMemory,
    listMemory,
    addMemory,
    deleteMemory,
  ];
}

module.exports = createMemoryTools;
