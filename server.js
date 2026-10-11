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

  const sessions = new Map();
  const attempts = new Map();

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

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname === '/owner' || url.pathname === '/owner/' ? '/owner.html' : url.pathname;
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
