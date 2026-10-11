#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const WEB_ROOT = path.join(ROOT, 'website');
const COOKIE = 'orient_owner_session';
const PASSWORD_MIN_LENGTH = 14;
const MAX_BODY_BYTES = 8192;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record || typeof password !== 'string' || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  const actual = crypto.scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function createOwnerServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.ORIENT_DATA_DIR || path.join(ROOT, '.orient-data'));
  const stateFile = path.join(dataDir, 'owner.json');
  const log = options.log || console.log;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch {}

  let state;
  let createdBootstrap = false;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.version !== 1 || !state.password || typeof state.mustChangePassword !== 'boolean') {
      throw new Error('Invalid owner state format');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read owner credentials safely: ' + error.message);
    const bootstrapPassword = options.bootstrapPassword || crypto.randomBytes(24).toString('base64url');
    state = {
      version: 1,
      username: 'Admin',
      password: hashPassword(bootstrapPassword),
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const fd = fs.openSync(stateFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.chmodSync(stateFile, 0o600); } catch {}
    createdBootstrap = true;
    log('ORIENT OWNER FIRST-RUN CREDENTIAL (shown once; keep private)');
    log('Username: Admin');
    log('Temporary password: ' + bootstrapPassword);
    log('Sign in locally and replace this password immediately.');
  }

  const usersFile = path.join(dataDir, 'users.json');
  let users = [];
  try {
    users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (!Array.isArray(users)) throw new Error('Invalid user store format');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read user records safely: ' + error.message);
    const fd = fs.openSync(usersFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, '[]\\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(usersFile, 0o600); } catch {}
  }
  const userSessions = new Map();
  const sessions = new Map();
  const attempts = new Map();

  function persistUsers(nextUsers) {
    const temp = usersFile + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(nextUsers, null, 2) + '\\n', 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temp, usersFile);
      try { fs.chmodSync(usersFile, 0o600); } catch {}
      const dirFd = fs.openSync(dataDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
    users = nextUsers;
  }

  function userSessionFor(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/(?:^|;\\s*)orient_user_session=([A-Za-z0-9_-]+)/);
    if (!match) return null;
    const session = userSessions.get(match[1]);
    if (!session || session.expiresAt <= Date.now()) { userSessions.delete(match[1]); return null; }
    return { token: match[1], ...session };
  }

  function userCookie(token, req) {
    const secure = req.socket.encrypted ? '; Secure' : '';
    return 'orient_user_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + secure;
  }

  function persist(nextState) {
    const temp = stateFile + '.tmp.' + process.pid + '.' + crypto.randomUUID();
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(nextState, null, 2) + '\n', { encoding: 'utf8' });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temp, stateFile);
      try { fs.chmodSync(stateFile, 0o600); } catch {}
      const dirFd = fs.openSync(dataDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    state = nextState;
  }

  function sessionFor(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)orient_owner_session=([A-Za-z0-9_-]+)/);
    if (!match) return null;
    const session = sessions.get(match[1]);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(match[1]);
      return null;
    }
    return { token: match[1], ...session };
  }

  function sessionCookie(token, req) {
    const secure = req.socket.encrypted ? '; Secure' : '';
    return COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + secure;
  }

  function clearCookie(req) {
    const secure = req.socket.encrypted ? '; Secure' : '';
    return COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure;
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return parsed.host === req.headers.host && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || 'unknown';

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const session = userSessionFor(req);
      if (session) return sendJson(res, 200, { username: session.username, role: 'user' });
      const owner = sessionFor(req);
      if (owner) return sendJson(res, 200, { username: 'Admin', role: 'owner', passwordChangeRequired: state.mustChangePassword });
      return sendJson(res, 401, { error: 'Authentication required' });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/auth/')) {
      if (!checkOrigin(req)) return sendJson(res, 403, { error: 'Request origin rejected' });
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }

      if (url.pathname === '/api/auth/register') {
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = body.password;
        if (!/^[A-Za-z0-9_ -]{3,32}$/.test(username)) return sendJson(res, 400, { error: 'اسم المستخدم يجب أن يكون من 3 إلى 32 حرفًا أو رقمًا.' });
        if (username.toLowerCase() === 'admin') return sendJson(res, 400, { error: 'اسم المستخدم محجوز.' });
        if (typeof password !== 'string' || password.length < 12 || password.length > 1024) return sendJson(res, 400, { error: 'استخدم كلمة مرور لا تقل عن 12 حرفًا.' });
        if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) return sendJson(res, 409, { error: 'اسم المستخدم مستخدم بالفعل.' });
        const user = { id: crypto.randomUUID(), username, password: hashPassword(password), role: 'user', createdAt: new Date().toISOString(), disabled: false };
        try { persistUsers([...users, user]); }
        catch { return sendJson(res, 500, { error: 'تعذر حفظ الحساب بأمان.' }); }
        const token = crypto.randomBytes(32).toString('base64url');
        userSessions.set(token, { userId: user.id, username: user.username, role: 'user', expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return sendJson(res, 201, { ok: true, username, role: 'user' }, { 'Set-Cookie': userCookie(token, req) });
      }

      if (url.pathname === '/api/auth/login') {
        if (typeof body.username !== 'string' || typeof body.password !== 'string') return sendJson(res, 400, { error: 'أدخل اسم المستخدم وكلمة المرور.' });
        const user = users.find(item => item.username.toLowerCase() === body.username.trim().toLowerCase());
        if (!user || user.disabled || !verifyPassword(body.password, user.password)) return sendJson(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
        const token = crypto.randomBytes(32).toString('base64url');
        userSessions.set(token, { userId: user.id, username: user.username, role: 'user', expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return sendJson(res, 200, { ok: true, username: user.username, role: 'user' }, { 'Set-Cookie': userCookie(token, req) });
      }

      if (url.pathname === '/api/auth/logout') {
        const session = userSessionFor(req);
        if (session) userSessions.delete(session.token);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'orient_user_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (req.method === 'GET' && url.pathname === '/api/owner/users') {
      const session = sessionFor(req);
      if (!session) return sendJson(res, 401, { error: 'Owner authentication required' });
      if (state.mustChangePassword) return sendJson(res, 403, { error: 'Password change required' });
      return sendJson(res, 200, { count: users.length, users: users.map(({ id, username, role, createdAt, disabled }) => ({ id, username, role, createdAt, disabled })) });
    }

    if (req.method === 'GET' && url.pathname === '/api/owner/status') {
      return sendJson(res, 200, { ownerExists: true, passwordChangeRequired: state.mustChangePassword });
    }

    if (req.method === 'GET' && url.pathname === '/api/owner/me') {
      const session = sessionFor(req);
      if (!session) return sendJson(res, 401, { error: 'Authentication required' });
      return sendJson(res, 200, { username: 'Admin', passwordChangeRequired: state.mustChangePassword });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/owner/')) {
      if (!checkOrigin(req)) return sendJson(res, 403, { error: 'Request origin rejected' });
      const attempt = attempts.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now() && attempt.count >= 10) {
        return sendJson(res, 429, { error: 'Too many attempts. Wait 15 minutes.' }, { 'Retry-After': String(Math.ceil((attempt.until - Date.now()) / 1000)) });
      }
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message }); }

      if (url.pathname === '/api/owner/login') {
        if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
            body.username !== 'Admin' || !verifyPassword(body.password, state.password)) {
          const next = attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 15 * 60 * 1000 };
          next.count += 1;
          attempts.set(ip, next);
          return sendJson(res, 401, { error: 'Invalid username or password' });
        }
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return sendJson(res, 200, { ok: true, username: 'Admin', passwordChangeRequired: state.mustChangePassword }, { 'Set-Cookie': sessionCookie(token, req) });
      }

      if (url.pathname === '/api/owner/password') {
        const session = sessionFor(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required' });
        if (typeof body.password !== 'string' || body.password.length < PASSWORD_MIN_LENGTH || body.password.length > 1024) {
          return sendJson(res, 400, { error: 'Use a password of at least 14 characters.' });
        }
        if (body.password !== body.confirmPassword) {
          return sendJson(res, 400, { error: 'Passwords do not match.' });
        }
        if (state.mustChangePassword && verifyPassword(body.password, state.password)) {
          return sendJson(res, 400, { error: 'Choose a new password, not the temporary password.' });
        }
        const nextState = { ...state, password: hashPassword(body.password), mustChangePassword: false, updatedAt: new Date().toISOString() };
        try { persist(nextState); }
        catch { return sendJson(res, 500, { error: 'Could not safely save the new password. No changes were confirmed.' }); }
        return sendJson(res, 200, { ok: true, passwordChangeRequired: false });
      }

      if (url.pathname === '/api/owner/logout') {
        const session = sessionFor(req);
        if (session) sessions.delete(session.token);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    }

    if (req.method === 'GET' && (url.pathname === '/owner' || url.pathname === '/owner/' || url.pathname === '/dashboard.html')) {
      const ownerSession = sessionFor(req);
      if (!ownerSession) {
        res.writeHead(302, { Location: '/auth?mode=owner', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (state.mustChangePassword) {
        if (url.pathname !== '/owner.html') {
          res.writeHead(302, { Location: '/owner.html', 'Cache-Control': 'no-store' });
          return res.end();
        }
      } else if (url.pathname !== '/dashboard.html') {
        res.writeHead(302, { Location: '/dashboard.html', 'Cache-Control': 'no-store' });
        return res.end();
      }
    }

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname === '/auth' || url.pathname === '/auth/' ? '/auth.html' : url.pathname;
    let filePath;
    try { filePath = path.resolve(WEB_ROOT, '.' + decodeURIComponent(pathname)); }
    catch { return sendJson(res, 400, { error: 'Invalid path' }); }
    if (!filePath.startsWith(WEB_ROOT + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
    let stat;
    try { stat = fs.statSync(filePath); }
    catch { return sendJson(res, 404, { error: 'Not found' }); }
    if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });

  return { server, stateFile, dataDir, createdBootstrap };
}

if (require.main === module) {
  const { server } = createOwnerServer();
  const host = process.env.ORIENT_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8080);
  server.listen(port, host, () => {
    console.log('ORIENT website + owner authentication running at http://' + host + ':' + port);
    if (host === '127.0.0.1') console.log('Local-only binding is enabled. Do not expose this server directly to the public internet.');
  });
}

module.exports = { createOwnerServer, hashPassword, verifyPassword };
