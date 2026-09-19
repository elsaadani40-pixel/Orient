const ToolInterface = require('../../core/tools/tool.interface');

function createMemoryTools(memoryService) {
  const searchMemory = new ToolInterface({
    name: 'memory.search',
    description: 'البحث داخل ذاكرة ORIENT ONE',
    execute: async (input) => {
      const query = String(input || '').trim();

      return {
        query,
        memories: memoryService.list(query),
      };
    },
  });

  const listMemory = new ToolInterface({
    name: 'memory.list',
    description: 'عرض الذكريات المحفوظة',
    execute: async () => {
      return {
        memories: memoryService.list(),
      };
    },
  });

  const addMemory = new ToolInterface({
    name: 'memory.add',
    description: 'إضافة معلومة جديدة إلى ذاكرة ORIENT ONE',
    execute: async (input) => {
      const text =
        typeof input === 'string'
          ? input
          : input && input.text;

      return memoryService.add(text, input && typeof input === 'object'
        ? input
        : {});
    },
  });

  const deleteMemory = new ToolInterface({
    name: 'memory.delete',
    description: 'حذف معلومة من ذاكرة ORIENT ONE',
    execute: async (input) => {
      const id =
        typeof input === 'string'
          ? input
          : input && input.id;

      return memoryService.delete(id);
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
