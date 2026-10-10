const http = require('http');
const { randomUUID } = require('node:crypto');
const { URL } = require('url');

const AppError = require('../../core/errors/AppError');
const logger = require('../../core/logging/logger');
const { createAccessAuditEvent } = require('../../core/security/access-audit-event');

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;

      if (size > maxBytes) {
        reject(
          new AppError(
            'Request body too large',
            413,
            'REQUEST_TOO_LARGE'
          )
        );

        req.destroy();
        return;
      }

      body += chunk.toString();
    });

    req.on('end', () => resolve(body));

    req.on('error', reject);
  });
}


function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]{1,80}$/.test(name)) cookies[name] = value;
  }
  return cookies;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    return parsed.origin === protocol + '//' + host.toLowerCase();
  } catch (_) {
    return false;
  }
}

function createServer({ memoryRoutes, agentRoutes, accessAudit = null, ownerAuth = null }) {
  return http.createServer(async (req, res) => {
    const requestStartedAt = Date.now();
    const requestId = randomUUID();
    const requestUrl = new URL(
      req.url,
      'http://localhost'
    );
    let authenticationOutcome = 'not_evaluated';

    res.setHeader('X-Request-ID', requestId);
    res.on('finish', () => {
      if (!accessAudit || typeof accessAudit.record !== 'function') return;
      const event = createAccessAuditEvent({
        requestId,
        sourceIp: req.socket?.remoteAddress,
        method: req.method,
        pathname: requestUrl.pathname,
        statusCode: res.statusCode,
        userAgent: req.headers['user-agent'],
        durationMs: Date.now() - requestStartedAt,
        authenticationOutcome
      });
      Promise.resolve(accessAudit.record(event)).catch(() => {
        logger.error('Access audit write failed', { code: 'ACCESS_AUDIT_WRITE_FAILED' });
      });
    });

    try {
      if (req.method === 'GET' && requestUrl.pathname === '/owner') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Pragma': 'no-cache',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'owner-dashboard.html'), 'utf8'));
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/owner-dashboard.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'"
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'owner-dashboard.js'), 'utf8'));
        return;
      }

      const ownerCookie = parseCookies(req.headers.cookie).orient_owner_session;
      const ownerSession = ownerAuth && ownerAuth.enabled
        ? ownerAuth.authenticate(ownerCookie)
        : null;

      if (req.method === 'POST' && requestUrl.pathname === '/owner/login') {
        authenticationOutcome = 'unauthenticated';
        if (!ownerAuth || !ownerAuth.enabled) {
          sendJson(res, 503, { ok: false, code: 'OWNER_AUTH_NOT_CONFIGURED', message: 'لم يتم إعداد كلمة مرور المالك محليًا.' });
          return;
        }
        if (!isSameOrigin(req)) {
          authenticationOutcome = 'csrf_rejected';
          sendJson(res, 403, { ok: false, code: 'OWNER_ORIGIN_REJECTED', message: 'تم رفض مصدر الطلب.' });
          return;
        }
        const rawBody = await readBody(req, 4096);
        let payload;
        try {
          payload = JSON.parse(rawBody || '{}');
        } catch (_) {
          sendJson(res, 400, { ok: false, code: 'INVALID_JSON', message: 'صيغة الطلب غير صحيحة.' });
          return;
        }
        const result = await ownerAuth.login({
          password: payload.password,
          sourceIp: req.socket?.remoteAddress || 'unknown'
        });
        if (!result.ok) {
          authenticationOutcome = 'owner_login_failed';
          const status = ['OWNER_LOGIN_RATE_LIMITED', 'OWNER_SESSION_LIMIT_REACHED'].includes(result.code) ? 429 : 401;
          sendJson(res, status, { ok: false, code: result.code, message: 'تعذر تسجيل الدخول.' });
          return;
        }
        authenticationOutcome = 'owner_login_success';
        const secure = req.socket?.encrypted ? '; Secure' : '';
        const maxAge = Math.max(1, Math.floor((result.expiresAt - Date.now()) / 1000));
        sendJson(res, 200, { ok: true, csrfToken: result.csrfToken, expiresAt: result.expiresAt }, {
          'Set-Cookie': 'orient_owner_session=' + result.token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure
        });
        return;
      }

      if (requestUrl.pathname.startsWith('/owner/')) {
        if (!ownerAuth || !ownerAuth.enabled) {
          sendJson(res, 503, { ok: false, code: 'OWNER_AUTH_NOT_CONFIGURED', message: 'لم يتم إعداد مصادقة المالك.' });
          return;
        }
        if (!ownerSession) {
          authenticationOutcome = 'unauthenticated';
          sendJson(res, 401, { ok: false, code: 'OWNER_AUTH_REQUIRED', message: 'يلزم تسجيل دخول المالك.' }, {
            'Set-Cookie': 'orient_owner_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (req.socket?.encrypted ? '; Secure' : '')
          });
          return;
        }
        authenticationOutcome = 'authenticated';

        if (req.method === 'GET' && requestUrl.pathname === '/owner/session') {
          sendJson(res, 200, { ok: true, csrfToken: ownerSession.csrfToken, expiresAt: ownerSession.expiresAt });
          return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/owner/audit') {
          if (!accessAudit || typeof accessAudit.listRecent !== 'function') {
            sendJson(res, 503, { ok: false, code: 'AUDIT_VIEW_UNAVAILABLE', message: 'سجل التدقيق غير متاح.' });
            return;
          }
          try {
            const events = await accessAudit.listRecent(100);
            sendJson(res, 200, { ok: true, events });
          } catch (error) {
            logger.error('Owner audit view failed', { code: error.code || 'OWNER_AUDIT_READ_FAILED' });
            sendJson(res, 503, { ok: false, code: 'AUDIT_VIEW_UNAVAILABLE', message: 'تعذر قراءة سجل التدقيق.' });
          }
          return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/owner/approvals') {
          if (!agentRoutes || typeof agentRoutes.pendingApprovals !== 'function') {
            sendJson(res, 503, { ok: false, code: 'APPROVAL_INBOX_UNAVAILABLE', message: 'صندوق الموافقات غير متاح.' });
            return;
          }
          await agentRoutes.pendingApprovals(req, res);
          return;
        }

        const ownerResumeMatch = requestUrl.pathname.match(/^\/owner\/executions\/([A-Za-z0-9_-]{1,200})\/resume$/);
        if (req.method === 'POST' && ownerResumeMatch) {
          if (!isSameOrigin(req) || !ownerAuth.verifyCsrf(ownerSession, req.headers['x-orient-csrf'])) {
            authenticationOutcome = 'csrf_rejected';
            sendJson(res, 403, { ok: false, code: 'OWNER_CSRF_REJECTED', message: 'تم رفض الطلب لأسباب أمنية.' });
            return;
          }
          if (!agentRoutes || typeof agentRoutes.resume !== 'function') {
            sendJson(res, 503, { ok: false, code: 'EXECUTION_RESUME_UNAVAILABLE', message: 'استئناف التنفيذ غير متاح.' });
            return;
          }
          const rawBody = await readBody(req, 8192);
          let payload;
          try { payload = JSON.parse(rawBody || '{}'); } catch (_) {
            sendJson(res, 400, { ok: false, code: 'INVALID_JSON', message: 'صيغة الطلب غير صحيحة.' });
            return;
          }
          const approvalId = payload?.approval?.approvalId;
          if (typeof approvalId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(approvalId)) {
            sendJson(res, 400, { ok: false, code: 'APPROVAL_ID_REQUIRED', message: 'معرّف الموافقة غير صالح.' });
            return;
          }
          await agentRoutes.resume(req, res, ownerResumeMatch[1], { approval: { approvalId } });
          return;
        }

        const ownerCancelMatch = requestUrl.pathname.match(/^\/owner\/executions\/([A-Za-z0-9_-]{1,200})\/cancel$/);
        if (req.method === 'POST' && ownerCancelMatch) {
          if (!isSameOrigin(req) || !ownerAuth.verifyCsrf(ownerSession, req.headers['x-orient-csrf'])) {
            authenticationOutcome = 'csrf_rejected';
            sendJson(res, 403, { ok: false, code: 'OWNER_CSRF_REJECTED', message: 'تم رفض الطلب لأسباب أمنية.' });
            return;
          }
          if (!agentRoutes || typeof agentRoutes.cancel !== 'function') {
            sendJson(res, 503, { ok: false, code: 'EXECUTION_CANCEL_UNAVAILABLE', message: 'إلغاء التنفيذ غير متاح.' });
            return;
          }
          const rawBody = await readBody(req, 8192);
          let payload;
          try { payload = JSON.parse(rawBody || '{}'); } catch (_) {
            sendJson(res, 400, { ok: false, code: 'INVALID_JSON', message: 'صيغة الطلب غير صحيحة.' });
            return;
          }
          await agentRoutes.cancel(req, res, ownerCancelMatch[1], { reason: 'owner_rejected', ...payload });
          return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/owner/logout') {
          if (!isSameOrigin(req) || !ownerAuth.verifyCsrf(ownerSession, req.headers['x-orient-csrf'])) {
            authenticationOutcome = 'csrf_rejected';
            sendJson(res, 403, { ok: false, code: 'OWNER_CSRF_REJECTED', message: 'تم رفض الطلب لأسباب أمنية.' });
            return;
          }
          ownerAuth.logout(ownerCookie);
          sendJson(res, 200, { ok: true }, {
            'Set-Cookie': 'orient_owner_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (req.socket?.encrypted ? '; Secure' : '')
          });
          return;
        }

        sendJson(res, 404, { ok: false, code: 'OWNER_ROUTE_NOT_FOUND', message: 'المسار غير موجود.' });
        return;
      }

      // In the production composition, the owner session protects every operational
      // page and API. The standalone server tests may omit ownerAuth deliberately.
      if (ownerAuth) {
        if (!ownerAuth.enabled) {
          sendJson(res, 503, { ok: false, code: 'OWNER_AUTH_NOT_CONFIGURED', message: 'لم يتم إعداد مصادقة المالك.' });
          return;
        }
        if (!ownerSession) {
          authenticationOutcome = 'unauthenticated';
          sendJson(res, 401, { ok: false, code: 'OWNER_AUTH_REQUIRED', message: 'يلزم تسجيل دخول المالك.' }, {
            'Set-Cookie': 'orient_owner_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (req.socket?.encrypted ? '; Secure' : '')
          });
          return;
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req)) {
          authenticationOutcome = 'csrf_rejected';
          sendJson(res, 403, { ok: false, code: 'OWNER_ORIGIN_REJECTED', message: 'تم رفض مصدر الطلب.' });
          return;
        }
        authenticationOutcome = 'authenticated';
      }

      // Unified v1 task reads deliberately reuse the existing AgentService/runtime
      // and sit after the shared owner-session and origin protections above.
      if (req.method === 'GET' && requestUrl.pathname === '/api/v1/tasks') {
        await agentRoutes.tasks(req, res);
        return;
      }

      const v1TaskMatch = requestUrl.pathname.match(new RegExp('^/api/v1/tasks/([A-Za-z0-9_-]{1,200})
      if (req.method === 'GET' && v1TaskMatch) {
        await agentRoutes.task(req, res, v1TaskMatch[1]);
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/command-scene.js'
      ) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'"
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'command-scene.js'), 'utf8'));
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/dashboard'
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          'Referrer-Policy': 'no-referrer'
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'dashboard.html'), 'utf8'));
        return;
      }
      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/'
      ) {
        memoryRoutes.home(req, res, requestUrl);
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/memory/add'
      ) {
        const body = await readBody(req);
        memoryRoutes.add(req, res, body);
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/memory/delete'
      ) {
        const body = await readBody(req);
        memoryRoutes.delete(req, res, body);
        return;
      }

      const executionEventsMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/events$/);

      if (
        req.method === 'GET' &&
        executionEventsMatch
      ) {
        await agentRoutes.events(
          req,
          res,
          decodeURIComponent(executionEventsMatch[1])
        );
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/executions'
      ) {
        await agentRoutes.executions(req, res);
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/approvals/pending'
      ) {
        await agentRoutes.pendingApprovals(req, res);
        return;
      }

      const executionStatusMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)$/);

      if (
        req.method === 'GET' &&
        executionStatusMatch
      ) {
        await agentRoutes.status(
          req,
          res,
          decodeURIComponent(executionStatusMatch[1])
        );
        return;
      }

      const executionApprovalsMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/approvals$/);

      if (
        req.method === 'GET' &&
        executionApprovalsMatch
      ) {
        await agentRoutes.approvals(
          req,
          res,
          decodeURIComponent(executionApprovalsMatch[1])
        );
        return;
      }

      const executionCancelMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/cancel$/);

      if (
        req.method === 'POST' &&
        executionCancelMatch
      ) {
        const body = await readBody(req);
        await agentRoutes.cancel(
          req,
          res,
          decodeURIComponent(executionCancelMatch[1]),
          body
        );
        return;
      }

      const executionResumeMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/resume$/);

      if (
        req.method === 'POST' &&
        executionResumeMatch
      ) {
        const body = await readBody(req);
        await agentRoutes.resume(
          req,
          res,
          decodeURIComponent(executionResumeMatch[1]),
          body
        );
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/agent'
      ) {
        const body = await readBody(req);
        await agentRoutes.execute(req, res, body);
        return;
      }

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('Not found');
    } catch (error) {
      logger.error(error.message, {
        code: error.code,
        statusCode: error.statusCode
      });

      const statusCode =
        error instanceof AppError
          ? error.statusCode
          : 500;

      const message =
        error instanceof AppError
          ? error.message
          : 'Internal server error';

      res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(message);
    }
  });
}

module.exports = createServer;
));
      if (req.method === 'GET' && v1TaskMatch) {
        await agentRoutes.task(req, res, v1TaskMatch[1]);
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/command-scene.js'
      ) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'"
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'command-scene.js'), 'utf8'));
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/dashboard'
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          'Referrer-Policy': 'no-referrer'
        });
        res.end(require('fs').readFileSync(require('path').join(__dirname, 'dashboard.html'), 'utf8'));
        return;
      }
      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/'
      ) {
        memoryRoutes.home(req, res, requestUrl);
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/memory/add'
      ) {
        const body = await readBody(req);
        memoryRoutes.add(req, res, body);
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/memory/delete'
      ) {
        const body = await readBody(req);
        memoryRoutes.delete(req, res, body);
        return;
      }

      const executionEventsMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/events$/);

      if (
        req.method === 'GET' &&
        executionEventsMatch
      ) {
        await agentRoutes.events(
          req,
          res,
          decodeURIComponent(executionEventsMatch[1])
        );
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/executions'
      ) {
        await agentRoutes.executions(req, res);
        return;
      }

      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/approvals/pending'
      ) {
        await agentRoutes.pendingApprovals(req, res);
        return;
      }

      const executionStatusMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)$/);

      if (
        req.method === 'GET' &&
        executionStatusMatch
      ) {
        await agentRoutes.status(
          req,
          res,
          decodeURIComponent(executionStatusMatch[1])
        );
        return;
      }

      const executionApprovalsMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/approvals$/);

      if (
        req.method === 'GET' &&
        executionApprovalsMatch
      ) {
        await agentRoutes.approvals(
          req,
          res,
          decodeURIComponent(executionApprovalsMatch[1])
        );
        return;
      }

      const executionCancelMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/cancel$/);

      if (
        req.method === 'POST' &&
        executionCancelMatch
      ) {
        const body = await readBody(req);
        await agentRoutes.cancel(
          req,
          res,
          decodeURIComponent(executionCancelMatch[1]),
          body
        );
        return;
      }

      const executionResumeMatch =
        requestUrl.pathname.match(/^\/executions\/([^/]+)\/resume$/);

      if (
        req.method === 'POST' &&
        executionResumeMatch
      ) {
        const body = await readBody(req);
        await agentRoutes.resume(
          req,
          res,
          decodeURIComponent(executionResumeMatch[1]),
          body
        );
        return;
      }

      if (
        req.method === 'POST' &&
        requestUrl.pathname === '/agent'
      ) {
        const body = await readBody(req);
        await agentRoutes.execute(req, res, body);
        return;
      }

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('Not found');
    } catch (error) {
      logger.error(error.message, {
        code: error.code,
        statusCode: error.statusCode
      });

      const statusCode =
        error instanceof AppError
          ? error.statusCode
          : 500;

      const message =
        error instanceof AppError
          ? error.message
          : 'Internal server error';

      res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(message);
    }
  });
}

module.exports = createServer;
