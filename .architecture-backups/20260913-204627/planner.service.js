const AppError = require('../../core/errors/AppError');

class PlannerService {
  constructor() {
    this.name = 'ORIENT_PLANNER';
    this.version = '0.7.1';
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
      return this.normalizePlan(multiStepPlan);
    }

    const memoryQuery =
      this.extractMemoryQuery(text);

    if (memoryQuery) {
      return this.normalizePlan(
        this.createPlan({
          intent: 'memory.search',
          tool: 'memory.search',
          input: memoryQuery,
          confidence: 0.98,
          reason: 'تم التعرف على طلب بحث في الذاكرة'
        })
      );
    }

    if (
      text.includes('ذاكرتي') ||
      text.includes('المحفوظ') ||
      text.includes('معلوماتي')
    ) {
      return this.normalizePlan(
        this.createPlan({
          intent: 'memory.list',
          tool: 'memory.list',
          input: null,
          confidence: 0.99,
          reason: 'تم التعرف على طلب عرض الذاكرة'
        })
      );
    }

    const addMemory =
      this.extractAddMemory(text);

    if (addMemory) {
      return this.normalizePlan(
        this.createPlan({
          intent: 'memory.add',
          tool: 'memory.add',
          input: addMemory,
          confidence: 0.95,
          reason: 'تم التعرف على طلب حفظ معلومة'
        })
      );
    }

    return this.normalizePlan(
      this.createPlan({
        intent: 'unknown',
        tool: null,
        input: null,
        confidence: 0,
        reason: 'لم يتم العثور على Tool مناسبة'
      })
    );
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
            input,
            dependsOn: null
          }
        ]
      : [];

    return plan;
  }

  normalizePlan(plan) {
    if (!plan || typeof plan !== 'object') {
      throw new AppError(
        'لا يمكن تطبيع خطة غير صالحة',
        500,
        'PLAN_NORMALIZATION_FAILED'
      );
    }

    const normalized = {
      ...plan
    };

    if (Array.isArray(plan.steps)) {
      normalized.steps = plan.steps.map(
        (step, index) => ({
          step: index + 1,
          tool: step.tool || null,
          input:
            this.normalizeStepInput(
              step.tool,
              step.input
            ),
          dependsOn:
            step.dependsOn === undefined
              ? null
              : step.dependsOn
        })
      );
    }

    return normalized;
  }

  normalizeStepInput(tool, input) {
    if (
      tool === 'memory.add' &&
      input &&
      typeof input === 'object'
    ) {
      return {
        ...input,
        text: this.normalizeMemoryText(
          input.text
        )
      };
    }

    if (typeof input === 'string') {
      return input.trim();
    }

    return input;
  }

  normalizeMemoryText(text) {
    let value =
      String(text || '').trim();

    const leadingPatterns = [
      /^أن\s+/i,
      /^ان\s+/i,
      /^إن\s+/i,
      /^انني\s+/i,
      /^إنني\s+/i
    ];

    for (const pattern of leadingPatterns) {
      value = value.replace(
        pattern,
        ''
      ).trim();
    }

    return value;
  }

  extractMultiStepPlan(text) {
    const searchThenSave =
      text.match(
        /(?:ابحث|دور|دوّر|معلومات)\s+(?:عن\s+)?(.+?)\s+(?:و\s*)?(?:احفظ|سجل|افتكر|تذكر)\s+(.+)/i
      );

    if (searchThenSave) {
      const query =
        searchThenSave[1].trim();

      const memoryText =
        this.normalizeMemoryText(
          searchThenSave[2]
        );

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
            input: query,
            dependsOn: null
          },
          {
            step: 2,
            tool: 'memory.add',
            input: {
              text: memoryText,
              type: 'note',
              importance: 0.5
            },
            dependsOn: 1
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
      const match =
        text.match(pattern);

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
      /^أضف(?:\s+إلى)?(?:\s+الذاكرة)?\s+(.+)/i,
      /^اضف(?:\s+إلى)?(?:\s+الذاكرة)?\s+(.+)/i,
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
          this.normalizeMemoryText(
            match[1]
          );

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
