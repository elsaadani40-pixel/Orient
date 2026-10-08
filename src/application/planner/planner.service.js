const AppError = require('../../core/errors/AppError');

class PlannerService {
  constructor() {
    this.name = 'ORIENT_PLANNER';
    this.version = '0.7.1';
    this.maxSteps = 5;
  }

  async plan(input, { modelRouter = null, context = {} } = {}) {
    const text = String(input || '').trim();

    if (!text) {
      throw new AppError(
        'لا يمكن إنشاء خطة بدون طلب',
        400,
        'PLAN_INPUT_REQUIRED'
      );
    }

    if (modelRouter && modelRouter.list().length) {
      try {
        const modelResult = await modelRouter.complete({
          messages: [
            {
              role: 'system',
              content: 'You are ORIENT ONE planner. Return ONLY valid JSON with intent, confidence, reason, and steps. Each step must contain tool, input, and dependsOn. Never invent tools. Prefer memory.search, memory.list, memory.add, memory.delete when applicable.'
            },
            {
              role: 'user',
              content: text
            }
          ],
          input: text,
          agentId: this.resolveAgentId(text),
          requiredCapabilities: ['text-generation'],
          preferredLocality: 'local',
          preferredCostClass: 'free',
          context
        });

        const modelPlan = this.parseModelPlan(
          modelResult.text
        );

        if (modelPlan) {
          return this.normalizePlan({
            ...modelPlan,
            routing: modelResult.routing
          });
        }
      } catch (error) {
        // Model inference is an optional enhancement. The deterministic
        // planner remains the safe fallback when the local provider is
        // unavailable or returns an invalid plan.
        if (context && typeof context.record === 'function') {
          context.record('model.planning.fallback', {
            code: error?.code || 'MODEL_PLANNING_FAILED'
          });
        }
      }
    }

    const projectChangeProposal = this.extractProjectChangeProposal(text);
    if (projectChangeProposal) return this.normalizePlan(projectChangeProposal);

    const projectAudit = this.extractProjectAudit(text);
    if (projectAudit) return this.normalizePlan(projectAudit);

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

  parseModelPlan(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }

    let payload;

    try {
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      payload = JSON.parse(
        fenced ? fenced[1] : text
      );
    } catch {
      return null;
    }

    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (
      typeof payload.intent !== 'string' ||
      !Array.isArray(payload.steps)
    ) {
      return null;
    }

    if (payload.steps.length > this.maxSteps) {
      return null;
    }

    return {
      intent: payload.intent,
      tool: payload.steps[0]?.tool || null,
      input: payload.steps[0]?.input ?? null,
      confidence:
        typeof payload.confidence === 'number'
          ? payload.confidence
          : 0.5,
      reason:
        typeof payload.reason === 'string'
          ? payload.reason
          : 'Local model planning',
      steps: payload.steps
    };
  }

  replan({
    input,
    evaluation = null,
    previousPlan = null,
    context = null
  } = {}) {
    const text = String(input || '').trim();

    if (!text) {
      throw new AppError(
        'لا يمكن إعادة التخطيط بدون الطلب الأصلي',
        400,
        'REPLAN_INPUT_REQUIRED'
      );
    }

    /*
     * Replanning is intentionally conservative.
     *
     * The planner may receive a new input from the evaluation layer
     * in future versions. If none exists, we do not fabricate a
     * different plan from the same information.
     */
    const candidateInput =
      evaluation &&
      typeof evaluation === 'object' &&
      typeof evaluation.nextInput === 'string' &&
      evaluation.nextInput.trim()
        ? evaluation.nextInput.trim()
        : null;

    if (!candidateInput || candidateInput === text) {
      return null;
    }

    const planned =
      this.plan(candidateInput);

    return {
      ...planned,
      replan: true,
      replanReason:
        evaluation &&
        evaluation.reason
          ? evaluation.reason
          : 'تم إنشاء خطة بديلة بناءً على نتيجة التقييم',
      previousPlanIntent:
        previousPlan &&
        previousPlan.intent
          ? previousPlan.intent
          : null,
      contextRequestId:
        context &&
        context.requestId
          ? context.requestId
          : null
    };
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
      ...plan,
      agentId: plan.agentId || this.resolveAgentId(plan.intent || '')
    };

    if (Array.isArray(plan.steps)) {
      normalized.steps = plan.steps.map(
        (step, index) => ({
          step: index + 1,
          agentId: step.agentId || normalized.agentId,
          capability: step.capability || null,
          memoryScope:
            typeof step.memoryScope === 'string'
              ? step.memoryScope.trim()
              : null,
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

  resolveAgentId(value) {
    const text = String(value || '').toLowerCase();

    if (
      text.includes('memory.') ||
      text.includes('ذاكرة') ||
      text.includes('محفوظ') ||
      text.includes('معلوماتي')
    ) {
      return 'MEMORY_AGENT';
    }

    return 'RESEARCH_AGENT';
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

  extractProjectChangeProposal(text) {
    const value = String(text || '').trim();
    if (!/(اقترح|اقتراح|حلل.*مشكلة|change proposal|propose.*change|improvement|التغيير المقترح|proposed change)/i.test(value) || (!/(المشروع|المستودع|repository|project|التغيير المقترح|proposed change)/i.test(value))) return null;
    const wantsExecution = /(نفذ|apply|implement)/i.test(value); const steps = [{ step: 1, tool: 'project.propose_changes', input: null, dependsOn: null, agentId: 'PROJECT_BUILDER_AGENT', capability: 'workspace.read' }]; if (wantsExecution) steps.push({ step: 2, tool: 'project.execute_change', input: '$previousResult', dependsOn: 1, agentId: 'PROJECT_BUILDER_AGENT', capability: 'workspace.write' }); return { intent: wantsExecution ? 'project.change' : 'project.change.proposal', tool: 'project.propose_changes', input: null, agentId: 'PROJECT_BUILDER_AGENT', confidence: 0.99, reason: wantsExecution ? 'تنفيذ التغيير المقترح بعد التفويض' : 'إنتاج Change Proposal بدون تنفيذ', steps };
  }
  extractProjectAudit(text) {
    const value = String(text || '').trim();
    if (!/(افحص|راجع|دقق|حلل|audit|review) .*?(المشروع|المستودع|repository|project)/i.test(value)) return null;
    return {
      intent: 'project.audit', tool: 'project.audit', input: null, agentId: 'PROJECT_BUILDER_AGENT',
      confidence: 0.99, reason: 'تم التعرف على مهمة فحص مشروع قراءة فقط',
      steps: [{ step: 1, tool: 'project.audit', input: null, dependsOn: null }]
    };
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
