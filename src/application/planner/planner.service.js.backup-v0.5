const AppError = require('../../core/errors/AppError');

class PlannerService {
  constructor() {
    this.name = 'ORIENT_PLANNER';
    this.version = '0.1.0';
  }

  plan(input) {
    const text = String(input || '').trim();

    if (!text) {
      throw new AppError(
        'لا يمكن إنشاء خطة بدون طلب',
        400,
        'PLAN_INPUT_REQUIRED'
      );
    }

    const memoryQuery = this.extractMemoryQuery(text);

    if (memoryQuery) {
      return {
        intent: 'memory.search',
        tool: 'memory.search',
        input: memoryQuery,
        confidence: 0.98,
        reason: 'تم التعرف على طلب بحث في الذاكرة'
      };
    }

    if (
      text.includes('ذاكرتي') ||
      text.includes('المحفوظ') ||
      text.includes('معلوماتي')
    ) {
      return {
        intent: 'memory.list',
        tool: 'memory.list',
        input: null,
        confidence: 0.99,
        reason: 'تم التعرف على طلب عرض الذاكرة'
      };
    }

    const addMemory = this.extractAddMemory(text);

    if (addMemory) {
      return {
        intent: 'memory.add',
        tool: 'memory.add',
        input: addMemory,
        confidence: 0.95,
        reason: 'تم التعرف على طلب حفظ معلومة'
      };
    }

    return {
      intent: 'unknown',
      tool: null,
      input: null,
      confidence: 0,
      reason: 'لم يتم العثور على Tool مناسبة'
    };
  }

  extractMemoryQuery(text) {
    const patterns = [
      /ماذا تعرف عن (.+)/i,
      /ايه اللي تعرفه عن (.+)/i,
      /إيه اللي تعرفه عن (.+)/i,
      /معلومات عن (.+)/i,
      /ابحث عن (.+)/i,
      /دور على (.+)/i,
      /دوّر على (.+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match && match[1]) {
        const value = match[1].trim();

        if (value) {
          return value;
        }
      }
    }

    return null;
  }

  extractAddMemory(text) {
    const patterns = [
      /^احفظ(?:لي)?\s+(.+)/i,
      /^سجل(?:لي)?\s+(.+)/i,
      /^افتكر\s+(.+)/i,
      /^خلي بالك إن\s+(.+)/i,
      /^تذكر أن\s+(.+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match && match[1]) {
        const value = match[1].trim();

        if (value) {
          return {
            text: value,
            type: 'note',
            importance: 0.5
          };
        }
      }
    }

    return null;
  }
}

module.exports = PlannerService;
