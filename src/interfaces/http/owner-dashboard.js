'use strict';

(() => {
  const loginCard = document.getElementById('login-card');
  const consolePanel = document.getElementById('console');
  const loginForm = document.getElementById('login-form');
  const loginStatus = document.getElementById('login-status');
  const auditStatus = document.getElementById('audit-status');
  const auditRows = document.getElementById('audit-rows');
  const approvalStatus = document.getElementById('approval-status');
  const approvalItems = document.getElementById('approval-items');
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

  async function loadApprovals() {
    approvalStatus.textContent = 'جارٍ تحميل الموافقات…';
    approvalItems.replaceChildren();
    try {
      const result = await request('/owner/approvals?limit=50', { method: 'GET' });
      const approvals = Array.isArray(result)
        ? result
        : Array.isArray(result.approvals)
          ? result.approvals
          : Array.isArray(result.items)
            ? result.items
            : [];

      for (const approval of approvals) {
        const card = document.createElement('article');
        card.className = 'card';
        const heading = document.createElement('h3');
        heading.textContent = 'موافقة مطلوبة · ' + String(approval.tool || 'أداة غير معروفة');
        const details = document.createElement('p');
        details.className = 'muted';
        details.textContent = [
          'الصلاحية: ' + String(approval.capability || 'غير محددة'),
          'التنفيذ: ' + String(approval.executionId || ''),
          'الخطوة: ' + String(approval.step || ''),
          'تنتهي: ' + String(approval.expiresAt || '')
        ].join(' · ');
        card.append(heading, details);
        const summary = approval.summary;
        let canApprove = Boolean(summary && summary.kind === 'file_change' && Array.isArray(summary.changes) &&
          summary.changes.length > 0 && summary.changes.length === summary.changeCount);
        if (summary && summary.kind === 'file_change' && Array.isArray(summary.changes)) {
          for (const change of summary.changes) {
            const changeCard = document.createElement('section');
            changeCard.className = 'approval-change';
            const changeTitle = document.createElement('h4');
            changeTitle.textContent = String(change.action || 'invalid') + ' · ' + String(change.path || '(مسار غير محدد)');
            const hashes = document.createElement('p');
            hashes.className = 'muted';
            hashes.textContent = 'الحجم: ' + String(change.contentBytes || 0) + ' بايت · SHA-256 للمحتوى المقترح: ' + String(change.proposedContentSha256 || 'غير متاح') +
              (change.action === 'update' ? ' · SHA-256 المتوقع للملف الحالي: ' + String(change.expectedContentSha256 || 'غير متاح') : '');
            const contentDetails = document.createElement('details');
            const contentSummary = document.createElement('summary');
            contentSummary.textContent = 'مراجعة المحتوى المقترح كاملًا';
            const preview = document.createElement('pre');
            preview.className = 'code-preview';
            preview.textContent = String(change.proposedContent || '');
            contentDetails.append(contentSummary, preview);
            changeCard.append(changeTitle, hashes, contentDetails);
            if (change.contentTruncated || !change.path || !['create', 'update'].includes(change.action) || !change.proposedContentSha256 || change.contentHashValid !== true || (change.action === 'update' && !change.expectedContentSha256)) {
              canApprove = false;
              const warning = document.createElement('p');
              warning.className = 'muted';
              warning.textContent = 'المراجعة غير مكتملة؛ لا يمكن الموافقة على هذا التغيير من لوحة المالك.';
              changeCard.append(warning);
            }
            card.append(changeCard);
          }
        } else {
          canApprove = false;
          const warning = document.createElement('p');
          warning.className = 'muted';
          warning.textContent = 'لا توجد تفاصيل مراجعة كافية لهذا الإجراء. لا توافق عليه من هذه الواجهة؛ يمكنك إلغاء التنفيذ.';
          card.append(warning);
        }

        const actions = document.createElement('div');
        actions.className = 'row';
        const approve = document.createElement('button');
        approve.className = 'btn';
        approve.type = 'button';
        approve.textContent = 'موافقة واستئناف';
        approve.disabled = !canApprove;
        const cancel = document.createElement('button');
        cancel.className = 'btn secondary';
        cancel.type = 'button';
        cancel.textContent = 'رفض وإلغاء التنفيذ';

        approve.addEventListener('click', async () => {
          const changePaths = Array.isArray(approval.summary?.changes)
            ? approval.summary.changes.map(change => String(change.action || '') + ' ' + String(change.path || '')).join('\n')
            : '';
          const summaryText = 'الأداة: ' + String(approval.tool || '') +
            '\nالصلاحية: ' + String(approval.capability || '') +
            '\nالتنفيذ: ' + String(approval.executionId || '') +
            '\nالتغييرات:\n' + changePaths +
            '\nهل راجعت المحتوى المقترح وتوافق على استئناف التنفيذ؟';
          if (!window.confirm(summaryText)) return;
          approve.disabled = true;
          cancel.disabled = true;
          approvalStatus.textContent = 'جارٍ إرسال الموافقة…';
          try {
            const response = await request(
              '/owner/executions/' + encodeURIComponent(String(approval.executionId)) + '/resume',
              { method: 'POST', body: JSON.stringify({ approval: { approvalId: approval.approvalId } }) }
            );
            approvalStatus.textContent = 'تم إرسال الموافقة. حالة Runtime: ' + String(response.status || 'تمت معالجة الطلب');
            await Promise.all([loadApprovals(), loadAudit()]);
          } catch (error) {
            approvalStatus.textContent = error.message;
            if (error.status === 401) {
              csrfToken = null;
              setLoggedIn(false);
            }
            approve.disabled = false;
            cancel.disabled = false;
          }
        });

        cancel.addEventListener('click', async () => {
          if (!window.confirm('سيتم إلغاء التنفيذ ' + String(approval.executionId || '') + ' بدلًا من الموافقة. هل تريد المتابعة؟')) return;
          approve.disabled = true;
          cancel.disabled = true;
          approvalStatus.textContent = 'جارٍ إلغاء التنفيذ…';
          try {
            await request(
              '/owner/executions/' + encodeURIComponent(String(approval.executionId)) + '/cancel',
              { method: 'POST', body: JSON.stringify({ reason: 'owner_rejected' }) }
            );
            approvalStatus.textContent = 'تم إرسال طلب الإلغاء.';
            await Promise.all([loadApprovals(), loadAudit()]);
          } catch (error) {
            approvalStatus.textContent = error.message;
            if (error.status === 401) {
              csrfToken = null;
              setLoggedIn(false);
            }
            approve.disabled = false;
            cancel.disabled = false;
          }
        });

        actions.append(approve, cancel);
        card.append(actions);
        approvalItems.append(card);
      }

      approvalStatus.textContent = approvals.length
        ? 'عدد الموافقات المعلقة: ' + approvals.length
        : 'لا توجد موافقات معلقة.';
    } catch (error) {
      approvalStatus.textContent = error.message;
      if (error.status === 401) {
        csrfToken = null;
        setLoggedIn(false);
      }
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
      await Promise.all([loadAudit(), loadApprovals()]);
    } catch (error) {
      loginStatus.textContent = error.message;
    }
  });

  document.getElementById('refresh').addEventListener('click', loadAudit);
  document.getElementById('refresh-approvals').addEventListener('click', loadApprovals);
  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await request('/owner/logout', { method: 'POST', body: '{}' });
    } catch (_) {
      // The session may already have expired; clear the local view either way.
    }
    csrfToken = null;
    auditRows.replaceChildren();
    approvalItems.replaceChildren();
    setLoggedIn(false);
    loginStatus.textContent = 'تم تسجيل الخروج.';
  });

  async function restoreSession() {
    setLoggedIn(false);
    try {
      const result = await request('/owner/session', { method: 'GET' });
      csrfToken = result.csrfToken;
      setLoggedIn(true);
      await Promise.all([loadAudit(), loadApprovals()]);
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
