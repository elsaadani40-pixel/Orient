const AppError = require('../../core/errors/AppError');

class PlannerService {
  constructor() {
    this.name = 'ORIENT_PLANNER';
    this.version = '0.6.0';
    this.maxSteps = 5;
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

    const multiStepPlan =
      this.extractMultiStepPlan(text);

    if (multiStepPlan) {
      return multiStepPlan;
    }

    const memoryQuery =
      this.extractMemoryQuery(text);

    if (memoryQuery) {
      return this.createPlan({
        intent: 'memory.search',
        tool: 'memory.search',
        input: memoryQuery,
        confidence: 0.98,
        reason: 'تم التعرف على طلب بحث في الذاكرة'
      });
    }

    if (
      text.includes('ذاكرتي') ||
      text.includes('المحفوظ') ||
      text.includes('معلوماتي')
    ) {
      return this.createPlan({
        intent: 'memory.list',
        tool: 'memory.list',
        input: null,
        confidence: 0.99,
        reason: 'تم التعرف على طلب عرض الذاكرة'
      });
    }

    const addMemory =
      this.extractAddMemory(text);

    if (addMemory) {
      return this.createPlan({
        intent: 'memory.add',
        tool: 'memory.add',
        input: addMemory,
        confidence: 0.95,
        reason: 'تم التعرف على طلب حفظ معلومة'
      });
    }

    return this.createPlan({
      intent: 'unknown',
      tool: null,
      input: null,
      confidence: 0,
      reason: 'لم يتم العثور على Tool مناسبة'
    });
  }

  createPlan({
    intent,
    tool,
    input,
    confidence,
    reason
  }) {
    const plan = {
      intent,
      tool,
      input,
      confidence,
      reason
    };

    plan.steps = tool
      ? [
          {
            step: 1,
            tool,
            input
          }
        ]
      : [];

    return plan;
  }

  extractMultiStepPlan(text) {
    const searchThenSave =
      text.match(
        /(?:ابحث|دور|دوّر|معلومات)\s+(?:عن\s+)?(.+?)\s+(?:و|ثم)\s+(?:احفظ|سجل|افتكر|تذكر)\s+(.+)/i
      );

    if (searchThenSave) {
      const query =
        searchThenSave[1].trim();

      const memoryText =
        searchThenSave[2].trim();

      if (!query || !memoryText) {
        return null;
      }

      return {
        intent: 'memory.search_and_add',
        tool: 'memory.search',
        input: query,
        confidence: 0.92,
        reason:
          'تم التعرف على مهمة متعددة الخطوات',
        steps: [
          {
            step: 1,
            tool: 'memory.search',
            input: query
          },
          {
            step: 2,
            tool: 'memory.add',
            input: {
              text: memoryText,
              type: 'note',
              importance: 0.5
            }
          }
        ]
      };
    }

    return null;
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
        const value =
          match[1].trim();

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
      const match =
        text.match(pattern);

      if (match && match[1]) {
        const value =
          match[1].trim();

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
