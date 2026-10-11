'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const state = { selectedId: null, cursorOffset: 0, total: 0, pendingKey: null, pendingGoal: null, pollHandle: null, inFlight: false };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
  const statusLabel = value => {
    const key = String(value || 'unknown').toLowerCase();
    const labels = { queued: 'في الانتظار', pending: 'معلق', running: 'قيد التنفيذ', paused: 'متوقف مؤقتًا', awaiting_approval: 'ينتظر الموافقة', completed: 'مكتمل', failed: 'فشل', cancelled: 'أُلغي', rejected: 'مرفوض', unknown: 'غير معروف' };
    return labels[key] || String(value || 'غير معروف');
  };
  const safeDate = value => {
    if (!value) return 'غير متاح';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ar-EG');
  };
  function message(id, text, kind = '') {
    const node = $(id);
    node.textContent = text;
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('success', kind === 'success');
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 500) }; }
    if (!response.ok) {
      const error = new Error(body.message || body.code || ('HTTP ' + response.status));
      error.status = response.status;
      error.code = body.code;
      throw error;
    }
    return body;
  }
  function makeIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('المتصفح لا يوفر مولّد معرّف آمنًا؛ استخدم متصفحًا حديثًا عبر HTTPS أو localhost.');
  }
  function setConnection(ok, text) {
    $('connectionState').textContent = text;
    $('connectionDot').classList.toggle('ok', ok);
    $('connectionDot').classList.toggle('bad', !ok);
  }
  function statusClass(status) {
    const normalized = String(status || '').toLowerCase().replace(/[^a-z_-]/g, '');
    return ['completed', 'failed', 'cancelled', 'running', 'queued', 'pending'].includes(normalized) ? normalized : '';
  }
  function taskCard(task) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'task' + (task.id === state.selectedId ? ' selected' : '');
    card.setAttribute('aria-pressed', String(task.id === state.selectedId));
    const row = document.createElement('div');
    row.className = 'task-row';
    const id = document.createElement('strong');
    id.className = 'task-id';
    id.textContent = String(task.id || 'معرّف غير متاح');
    const badge = document.createElement('span');
    badge.className = 'state ' + statusClass(task.status);
    badge.textContent = statusLabel(task.status);
    row.append(id, badge);
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const created = document.createElement('span');
    created.textContent = 'بدأت: ' + safeDate(task.createdAt);
    const updated = document.createElement('span');
    updated.textContent = 'آخر تحديث: ' + safeDate(task.updatedAt);
    meta.append(created, updated);
    card.append(row, meta);
    card.addEventListener('click', () => { void selectTask(task.id); });
    return card;
  }
  function renderTasks(items, append = false) {
    const list = $('taskList');
    if (!append) list.replaceChildren();
    for (const task of items) {
      if (!task || typeof task.id !== 'string' || !task.id) continue;
      list.append(taskCard(task));
    }
    if (!list.children.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'لا توجد مهام في السجل حتى الآن.';
      list.append(empty);
    }
  }
  async function loadTasks({ append = false } = {}) {
    const offset = append ? state.cursorOffset : 0;
    message('listMessage', 'جارٍ قراءة المهام الفعلية من الخادم…');
    try {
      const result = await request('/api/v1/tasks?limit=20&offset=' + offset);
      const items = Array.isArray(result.items) ? result.items : [];
      state.total = Number(result.page?.total) || 0;
      state.cursorOffset = offset + items.length;
      renderTasks(items, append);
      $('loadMore').disabled = state.cursorOffset >= state.total || items.length === 0;
      message('listMessage', 'تم تحميل ' + items.length + ' مهمة في هذه الصفحة؛ الإجمالي الذي أعلنه الخادم: ' + state.total + '.', 'success');
      setConnection(true, 'الخادم متصل · تمت قراءة API المهام');
    } catch (error) {
      if (!append) {
        $('taskList').replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'تعذر تحميل المهام؛ لم يتم عرض بيانات بديلة.';
        $('taskList').append(empty);
      }
      $('loadMore').disabled = true;
      message('listMessage', 'فشل تحميل المهام: ' + error.message + (error.status === 401 ? '\nسجّل الدخول من مركز المالك /owner ثم افتح هذه الصفحة مجددًا.' : ''), 'error');
      setConnection(false, error.status === 401 ? 'يلزم تسجيل الدخول من /owner' : 'تعذر الاتصال بواجهة المهام');
    }
  }
  function renderDetails(task) {
    const root = $('taskDetails');
    root.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    const values = [
      ['الحالة', statusLabel(task.status)],
      ['الخطوة الحالية', task.currentStep == null ? 'غير متاحة' : task.currentStep],
      ['الإلغاء مطلوب', task.cancellationRequested ? 'نعم' : 'لا'],
      ['وقت الإنشاء', safeDate(task.createdAt)],
      ['آخر تحديث', safeDate(task.updatedAt)],
      ['وقت الاكتمال', safeDate(task.completedAt)]
    ];
    for (const [label, value] of values) {
      const cell = document.createElement('div');
      cell.className = 'detail-cell';
      const small = document.createElement('small');
      small.textContent = label;
      const strong = document.createElement('strong');
      strong.textContent = String(value);
      cell.append(small, strong);
      grid.append(cell);
    }
    const id = document.createElement('p');
    id.className = 'task-id';
    id.textContent = String(task.id || '');
    root.append(id, grid);
    $('refreshSelected').disabled = !state.selectedId;
    $('copyTaskId').disabled = !state.selectedId;
  }
  function renderEvents(items) {
    const root = $('taskEvents');
    root.replaceChildren();
    $('eventCount').textContent = String(items.length);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'لا توجد أحداث متاحة لهذه المهمة حتى الآن.';
      root.append(empty);
      return;
    }
    for (const event of items) {
      const card = document.createElement('article');
      card.className = 'event';
      const title = document.createElement('strong');
      title.textContent = String(event.type || 'حدث غير معروف') + (event.outcome ? ' · ' + event.outcome : '');
      const meta = document.createElement('small');
      meta.textContent = safeDate(event.timestamp) + ' · تسلسل ' + (event.sequence == null ? 'غير متاح' : event.sequence);
      card.append(title, meta);
      const detail = document.createElement('pre');
      detail.textContent = JSON.stringify({ stepId: event.stepId || undefined, details: event.details || undefined }, null, 2);
      card.append(detail);
      root.append(card);
    }
  }
  async function selectTask(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      message('submitMessage', 'معرّف المهمة غير صالح.', 'error');
      return;
    }
    state.selectedId = id;
    $('refreshSelected').disabled = false;
    $('copyTaskId').disabled = false;
    renderTasksFromCurrentList();
    await refreshSelected();
  }
  function renderTasksFromCurrentList() {
    const cards = Array.from($('taskList').querySelectorAll('.task'));
    for (const card of cards) {
      const id = card.querySelector('.task-id')?.textContent;
      card.classList.toggle('selected', id === state.selectedId);
      card.setAttribute('aria-pressed', String(id === state.selectedId));
    }
  }
  async function refreshSelected() {
    if (!state.selectedId || state.inFlight) return;
    state.inFlight = true;
    $('refreshSelected').disabled = true;
    $('taskDetails').textContent = 'جارٍ قراءة الحالة والأحداث…';
    try {
      const id = encodeURIComponent(state.selectedId);
      const [detail, eventPage] = await Promise.all([
        request('/api/v1/tasks/' + id),
        request('/api/v1/tasks/' + id + '/events?limit=50')
      ]);
      if (state.selectedId !== detail.task?.id) return;
      renderDetails(detail.task);
      renderEvents(Array.isArray(eventPage.items) ? eventPage.items : []);
      const task = detail.task;
      if (task && terminal.has(String(task.status).toLowerCase())) {
        message('submitMessage', 'الحالة التي أعادها الخادم: ' + statusLabel(task.status) + '. راجع الأحداث أدناه؛ لا تستنتج نجاحًا يتجاوز هذه الأدلة.', task.status === 'completed' ? 'success' : 'error');
      }
    } catch (error) {
      $('taskDetails').textContent = 'تعذر قراءة تفاصيل المهمة: ' + error.message;
      $('taskEvents').replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'لم يتم تحميل الأحداث بسبب فشل الطلب.';
      $('taskEvents').append(empty);
    } finally {
      state.inFlight = false;
      $('refreshSelected').disabled = !state.selectedId;
    }
  }
  async function submitTask(event) {
    event.preventDefault();
    const goal = $('goal').value.trim();
    if (!goal) {
      message('submitMessage', 'اكتب هدف المهمة أولًا.', 'error');
      return;
    }
    if (goal !== state.pendingGoal) {
      state.pendingGoal = goal;
      state.pendingKey = null;
    }
    if (!state.pendingKey) {
      try { state.pendingKey = makeIdempotencyKey(); }
      catch (error) { message('submitMessage', error.message, 'error'); return; }
    }
    const button = $('submitTask');
    button.disabled = true;
    message('submitMessage', 'جارٍ إرسال المهمة. إذا انقطع الاتصال بعد الإرسال، ستُعاد المحاولة بنفس مفتاح منع التكرار.');
    try {
      const result = await request('/api/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': state.pendingKey },
        body: JSON.stringify({ goal, idempotencyKey: state.pendingKey })
      });
      const task = result.task;
      if (!task || typeof task.id !== 'string') throw new Error('استجابة الخادم لا تحتوي على معرّف مهمة صالح.');
      state.pendingKey = null;
      state.pendingGoal = null;
      state.selectedId = task.id;
      $('goal').value = '';
      message('submitMessage', (result.replayed ? 'استجابة معاد تشغيلها لنفس الطلب. ' : 'استقبل الخادم المهمة. ') + 'المعرّف: ' + task.id + '\nالحالة الحالية: ' + statusLabel(task.status) + '. هذه ليست شهادة اكتمال.', 'success');
      await loadTasks();
      await selectTask(task.id);
    } catch (error) {
      message('submitMessage', 'لم يمكن تأكيد نتيجة الإرسال: ' + error.message + '\nأعد المحاولة دون تغيير نص المهمة للحفاظ على مفتاح منع التكرار.', 'error');
      setConnection(false, 'تعذر تأكيد نتيجة الطلب؛ قد تكون النتيجة غير محسومة');
    } finally {
      button.disabled = false;
    }
  }
  $('taskForm').addEventListener('submit', submitTask);
  document.querySelectorAll('[data-project-goal]').forEach(button => {
    button.addEventListener('click', () => {
      const goal = button.getAttribute('data-project-goal') || '';
      $('goal').value = goal;
      state.pendingGoal = null;
      state.pendingKey = null;
      message('submitMessage', 'تم تجهيز مهمة المشروع فقط. راجع نص الطلب ثم اضغط «إرسال المهمة»؛ لا يبدأ التنفيذ بمجرد اختيارها.');
      $('goal').focus();
    });
  });
  $('clearGoal').addEventListener('click', () => {
    $('goal').value = '';
    state.pendingGoal = null;
    state.pendingKey = null;
    message('submitMessage', 'تم مسح النص. لم يتم إرسال مهمة جديدة.');
  });
  $('refreshAll').addEventListener('click', async () => {
    await loadTasks();
    if (state.selectedId) await refreshSelected();
  });
  $('loadMore').addEventListener('click', () => { void loadTasks({ append: true }); });
  $('refreshSelected').addEventListener('click', () => { void refreshSelected(); });
  $('copyTaskId').addEventListener('click', async () => {
    if (!state.selectedId) return;
    try {
      await navigator.clipboard.writeText(state.selectedId);
      message('submitMessage', 'تم نسخ معرّف المهمة: ' + state.selectedId, 'success');
    } catch {
      message('submitMessage', 'تعذر النسخ التلقائي. معرّف المهمة: ' + state.selectedId, 'error');
    }
  });
  async function initialize() {
    await loadTasks();
    if (state.pollHandle) clearInterval(state.pollHandle);
    state.pollHandle = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadTasks();
      if (state.selectedId) void refreshSelected();
    }, 5000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void loadTasks();
      if (state.selectedId) void refreshSelected();
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.pollHandle) clearInterval(state.pollHandle);
  });
  void initialize();
})();
