'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const createServer = require('../../../../src/interfaces/http/server');
const createAgentRoutes = require('../../../../src/interfaces/http/routes/agent.routes');
const {
  assertPersistencePrincipal
} = require('../../../../src/infrastructure/persistence/postgres/persistence-principal');

function createOwnerAuth() {
  return {
    enabled: true,
    authenticate(token) {
      return token === 'valid-session-token'
        ? { sessionId: 'authenticated-session-123', csrfToken: 'csrf-proof' }
        : null;
    },
    status() {
      return { passwordChangeRequired: false };
    },
    verifyCsrf(session, token) {
      return session?.sessionId === 'authenticated-session-123' && token === 'csrf-proof';
    }
  };
}

async function withServer(server, run) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(origin);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('owner HTTP routes issue persistence principal from authenticated session and ignore forged request identity', async () => {
  const observed = {
    profileGet: null,
    profileUpdate: null,
    chatList: null,
    chatAppend: null,
    historyResolver: null,
    taskCreate: null
  };
  const ownerProfile = {
    async get(principal) {
      assertPersistencePrincipal(principal);
      observed.profileGet = principal;
      return { version: 1, mode: 'standard', workingPreferences: '', updatedAt: null };
    },
    async update(payload, principal) {
      assertPersistencePrincipal(principal);
      observed.profileUpdate = { principal, payload };
      return { version: 1, mode: payload.mode, workingPreferences: '', updatedAt: null };
    }
  };
  const ownerChatStore = {
    async list(principal) {
      assertPersistencePrincipal(principal);
      observed.chatList = principal;
      return [];
    },
    async append(message, principal) {
      assertPersistencePrincipal(principal);
      observed.chatAppend = { message, principal };
      return { message, replayed: false };
    },
    async clear(principal) {
      assertPersistencePrincipal(principal);
      return { cleared: true };
    }
  };
  const agentRoutes = {
    async createTask(req, res, body, ownerSessionContext, principal) {
      assertPersistencePrincipal(principal);
      observed.taskCreate = { body: JSON.parse(body), ownerSessionContext, principal };
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task: { id: 'task-http-principal' } }));
    }
  };
  const server = createServer({
    memoryRoutes: {},
    agentRoutes,
    ownerAuth: createOwnerAuth(),
    ownerProfile,
    ownerChatStore,
    ownerChatHistoryResolver: async (messages, principal) => {
      assertPersistencePrincipal(principal);
      observed.historyResolver = principal;
    },
    tenantId: 'tenant-from-server-config',
    ownerId: 'canonical-owner'
  });

  await withServer(server, async origin => {
    const cookie = 'orient_owner_session=valid-session-token';
    const forgedHeaders = {
      Cookie: cookie,
      'x-orient-tenant-id': 'attacker-tenant',
      'x-orient-owner-id': 'attacker-owner'
    };

    const profileRead = await fetch(origin + '/owner/profile?tenantId=attacker-query', {
      headers: forgedHeaders
    });
    assert.equal(profileRead.status, 200);

    const profileWrite = await fetch(origin + '/owner/profile', {
      method: 'PUT',
      headers: {
        ...forgedHeaders,
        Origin: origin,
        'content-type': 'application/json',
        'x-orient-csrf': 'csrf-proof'
      },
      body: JSON.stringify({
        mode: 'plan-only',
        tenantId: 'attacker-body-tenant',
        ownerId: 'attacker-body-owner',
        sessionId: 'attacker-body-session'
      })
    });
    assert.equal(profileWrite.status, 200);

    const history = await fetch(origin + '/owner/chat/history?ownerId=attacker', {
      headers: forgedHeaders
    });
    assert.equal(history.status, 200);

    const chat = await fetch(origin + '/owner/chat', {
      method: 'POST',
      headers: {
        ...forgedHeaders,
        Origin: origin,
        'content-type': 'application/json',
        'x-orient-csrf': 'csrf-proof'
      },
      body: JSON.stringify({
        message: 'Run a safe diagnostic',
        displayMessage: 'Please inspect the project',
        tenantId: 'attacker-body-tenant',
        ownerId: 'attacker-body-owner'
      })
    });
    assert.equal(chat.status, 201);
  });

  for (const principal of [
    observed.profileGet,
    observed.profileUpdate?.principal,
    observed.chatList,
    observed.chatAppend?.principal,
    observed.historyResolver,
    observed.taskCreate?.principal
  ]) {
    assert.ok(principal, 'every owner persistence operation must receive a principal');
    assert.deepEqual(principal, {
      tenantId: 'tenant-from-server-config',
      ownerId: 'canonical-owner',
      sessionId: 'authenticated-session-123'
    });
  }
  assert.equal(observed.profileUpdate.payload.tenantId, 'attacker-body-tenant');
  assert.equal(observed.taskCreate.ownerSessionContext.sessionId, 'authenticated-session-123');
  assert.equal(Object.hasOwn(observed.taskCreate.ownerSessionContext, 'persistencePrincipal'), false);
});

test('agent route callbacks preserve the same validated persistence principal through task creation and final answer', async () => {
  const principal = Object.freeze({
    tenantId: 'tenant-callback',
    ownerId: 'owner-callback',
    sessionId: 'session-callback'
  });
  const callbacks = [];
  let createTaskArgs = null;
  const agentService = {
    async createTask(args) {
      createTaskArgs = args;
      return { task: { id: 'task-callback' }, replayed: false };
    },
    async getExecutionStatus() {
      return { executionId: 'task-callback', status: 'completed' };
    },
    async getExecutionEvents() {
      return [];
    },
    async getExecutionApprovals() {
      return [];
    },
    async getFinalAnswer() {
      return { text: 'Completed safely.' };
    }
  };
  const routes = createAgentRoutes(agentService, {
    onTaskCreated: async event => callbacks.push({ type: 'created', principal: event.persistencePrincipal }),
    onFinalAnswer: async event => callbacks.push({ type: 'answer', principal: event.persistencePrincipal })
  });
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(body) { this.body = body || ''; }
  };
  const request = { headers: { 'idempotency-key': 'idem-callback' }, ownerChatMessageId: 'message-callback' };

  await routes.createTask(request, response, { goal: 'Do a safe task' }, {
    sessionId: 'authenticated-session-callback'
  }, principal);
  await routes.taskResponse(request, response, 'task-callback', principal);

  assert.deepEqual(callbacks.map(item => item.type), ['created', 'answer']);
  assert.equal(createTaskArgs.persistencePrincipal, principal);
  assert.equal(createTaskArgs.ownerSessionContext.sessionId, 'authenticated-session-callback');
  assert.equal(callbacks[0].principal, principal);
  assert.equal(callbacks[1].principal, principal);
});
