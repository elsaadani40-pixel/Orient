'use strict';

(() => {
  const loginCard = document.getElementById('login-card');
  const consolePanel = document.getElementById('console');
  const loginForm = document.getElementById('login-form');
  const loginStatus = document.getElementById('login-status');
  const auditStatus = document.getElementById('audit-status');
  const auditRows = document.getElementById('audit-rows');
  let csrfToken = null;

  function setLoggedIn(value) {
    loginCard.classList.toggle('hidden', value);
    consolePanel.classList.toggle('hidden', !value);
  }

  function textCell(value) {
    const cell = document.createElement('td');
    cell.textContent = value == null ? '' : String(value);
    return cell;
  }

  async function request(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (csrfToken && options.method && options.method !== 'GET') {
      headers['X-ORIENT-CSRF'] = csrfToken;
    }
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || 'تعذر إكمال الطلب');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadAudit() {
    auditStatus.textContent = 'جارٍ تحميل السجل…';
    auditRows.replaceChildren();
    try {
      const result = await request('/owner/audit', { method: 'GET' });
      for (const event of result.events || []) {
        const row = document.createElement('tr');
        row.append(
          textCell(event.timestamp),
          textCell(event.sourceIp),
          textCell(event.route),
          textCell(event.method),
          textCell(event.statusCode),
          textCell(event.authenticationOutcome),
          textCell(event.durationMs + ' ms')
        );
        auditRows.append(row);
      }
      auditStatus.textContent = (result.events || []).length
        ? 'تم تحميل أحدث الأحداث.'
        : 'لا توجد أحداث مسجلة بعد.';
    } catch (error) {
      if (error.status === 401) {
        csrfToken = null;
        setLoggedIn(false);
      }
      auditStatus.textContent = error.message;
    }
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginStatus.textContent = 'جارٍ التحقق…';
    const passwordInput = document.getElementById('password');
    try {
      const result = await request('/owner/login', {
        method: 'POST',
        body: JSON.stringify({ password: passwordInput.value })
      });
      csrfToken = result.csrfToken;
      passwordInput.value = '';
      loginStatus.textContent = '';
      setLoggedIn(true);
      await loadAudit();
    } catch (error) {
      loginStatus.textContent = error.message;
    }
  });

  document.getElementById('refresh').addEventListener('click', loadAudit);
  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await request('/owner/logout', { method: 'POST', body: '{}' });
    } catch (_) {
      // The session may already have expired; clear the local view either way.
    }
    csrfToken = null;
    auditRows.replaceChildren();
    setLoggedIn(false);
    loginStatus.textContent = 'تم تسجيل الخروج.';
  });

  async function restoreSession() {
    setLoggedIn(false);
    try {
      const result = await request('/owner/session', { method: 'GET' });
      csrfToken = result.csrfToken;
      setLoggedIn(true);
      await loadAudit();
    } catch (error) {
      if (error.status === 503) {
        loginStatus.textContent = 'مصادقة المالك غير مهيأة. اضبط ORIENT_OWNER_PASSWORD محليًا ثم أعد تشغيل الخدمة.';
      }
    }
  }

  // The server releases a CSRF token only after validating the HttpOnly session cookie.
  // No token or password is persisted in browser storage.
  restoreSession();
})();
