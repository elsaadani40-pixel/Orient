#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_URL = 'http://127.0.0.1:8080';

function resolveBaseUrl(value = process.env.ORIENT_URL || DEFAULT_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('ORIENT_URL must be a valid absolute URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ORIENT_URL must contain only an origin (scheme, host, and optional port)');
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw new Error('ORIENT_URL must use HTTPS, except for loopback HTTP during local development');
  }
  return url.origin;
}

function defaultSessionFile() {
  return process.env.ORIENT_CLI_SESSION_FILE ||
    path.join(os.homedir(), '.orient', 'cli-session.json');
}

function writeSession(file, session) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const temporary = file + '.' + process.pid + '.' + require('node:crypto').randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(session) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function readSession(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read ORIENT CLI session; run "orient logout" and sign in again');
  }
  if (!value || typeof value.baseUrl !== 'string' ||
      typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(value.token) ||
      typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(value.csrfToken) ||
      !Number.isSafeInteger(value.expiresAt)) {
    throw new Error('ORIENT CLI session file is invalid; run "orient logout" and sign in again');
  }
  return value;
}

function readSecret(prompt = 'Owner password: ') {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      const rl = readline.createInterface({ input, output: process.stderr });
      rl.question(prompt, answer => { rl.close(); resolve(answer); });
      rl.on('SIGINT', () => { rl.close(); reject(new Error('Cancelled')); });
      return;
    }
    process.stderr.write(prompt);
    let answer = '';
    const wasRaw = input.isRaw;
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(answer);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          answer = answer.slice(0, -1);
          continue;
        }
        if (character >= ' ') answer += character;
      }
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function createClient({ baseUrl, sessionFile = defaultSessionFile(), fetchImpl = globalThis.fetch }) {
  const origin = resolveBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation is required');

  async function request(route, { method = 'GET', body, session, csrf = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers.Cookie = 'orient_owner_session=' + session.token;
    if (method !== 'GET' && method !== 'HEAD') headers.Origin = origin;
    if (csrf) {
      if (!session) throw new Error('Owner sign-in required; run "orient login"');
      headers['X-ORIENT-CSRF'] = session.csrfToken;
    }
    let response;
    try {
      response = await fetchImpl(origin + route, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error('Cannot reach ORIENT. Check that the local server is running and ORIENT_URL is correct.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('ORIENT returned an invalid JSON response (HTTP ' + response.status + ')'); }
    if (!response.ok) {
      const messages = {
        401: 'Owner session expired or not signed in; run "orient login"',
        403: data.code === 'OWNER_PASSWORD_CHANGE_REQUIRED'
          ? 'Change the owner password in the ORIENT website before using the CLI'
          : 'ORIENT rejected this request (authorization or CSRF check)',
        429: 'Too many sign-in attempts; wait before retrying'
      };
      throw new Error(messages[response.status] || data.message || ('ORIENT request failed (HTTP ' + response.status + ')'));
    }
    return { data, response };
  }

  async function login(password) {
    const { data, response } = await request('/owner/login', {
      method: 'POST', body: { password }
    });
    const cookie = response.headers.get('set-cookie') || '';
    const match = cookie.match(/(?:^|[,; ]+)orient_owner_session=([A-Za-z0-9_-]{40,100})/);
    if (!match || typeof data.csrfToken !== 'string' || !Number.isSafeInteger(data.expiresAt)) {
      throw new Error('ORIENT login response did not contain a valid owner session');
    }
    const session = {
      baseUrl: origin, token: match[1], csrfToken: data.csrfToken, expiresAt: data.expiresAt
    };
    writeSession(sessionFile, session);
    return { session, passwordChangeRequired: data.passwordChangeRequired === true };
  }

  function getSession() {
    const session = readSession(sessionFile);
    if (!session || session.baseUrl !== origin || session.expiresAt <= Date.now()) {
      throw new Error('Owner session missing, expired, or belongs to another server; run "orient login"');
    }
    return session;
  }

  return {
    async login(password) { return login(password); },
    async logout() {
      let session = null;
      try { session = getSession(); } catch {}
      if (!session) {
        try { fs.rmSync(sessionFile, { force: true }); } catch {}
        return;
      }
      try {
        await request('/owner/logout', { method: 'POST', session, csrf: true });
      } catch (error) {
        throw new Error('Local session cleared, but remote logout could not be confirmed; the server session may remain valid until expiry or revocation. ' + error.message);
      } finally {
        try { fs.rmSync(sessionFile, { force: true }); } catch {}
      }
    },
    async listTasks({ limit = 20, offset = 0 } = {}) {
      const session = getSession();
      const { data } = await request('/api/v1/tasks?limit=' + encodeURIComponent(limit) + '&offset=' + encodeURIComponent(offset), { session });
      return data;
    },
    async showTask(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid task ID');
      const { data } = await request('/api/v1/tasks/' + encodeURIComponent(id), { session: getSession() });
      return data;
    },
    async createTask(goal) {
      if (typeof goal !== 'string' || !goal.trim() || goal.trim().length > 4000) {
        throw new Error('Task goal must contain 1–4000 characters');
      }
      const session = getSession();
      const { data } = await request('/api/v1/tasks', {
        method: 'POST', body: { goal: goal.trim() }, session, csrf: true
      });
      return data;
    }
  };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const client = createClient({});
  if (command === '--help' || command === '-h' || !command) {
    process.stdout.write([
      'ORIENT CLI — governed Runtime client',
      '',
      'Usage:',
      '  orient login',
      '  orient logout',
      '  orient tasks list',
      '  orient task show <id>',
      '  orient task create <goal>',
      '',
      'Environment: ORIENT_URL (default http://127.0.0.1:8080)',
      'The CLI stores only an expiring owner session in ~/.orient/cli-session.json.'
    ].join('\n') + '\n');
    return;
  }
  if (command === 'login') {
    const password = await readSecret();
    if (!password) throw new Error('Password cannot be empty');
    const result = await client.login(password);
    process.stdout.write(result.passwordChangeRequired
      ? 'Signed in. Change the temporary owner password in the website before using Runtime operations.\n'
      : 'Signed in to ORIENT.\n');
    return;
  }
  if (command === 'logout') {
    await client.logout();
    process.stdout.write('Local ORIENT CLI session cleared.\n');
    return;
  }
  if (command === 'tasks' && argv[1] === 'list') {
    printJson(await client.listTasks());
    return;
  }
  if (command === 'task' && argv[1] === 'show' && argv[2]) {
    printJson(await client.showTask(argv[2]));
    return;
  }
  if (command === 'task' && argv[1] === 'create' && argv.slice(2).join(' ').trim()) {
    printJson(await client.createTask(argv.slice(2).join(' ')));
    return;
  }
  throw new Error('Unknown command. Run "orient --help".');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('orient: ' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { createClient, resolveBaseUrl, readSession, writeSession, main };
