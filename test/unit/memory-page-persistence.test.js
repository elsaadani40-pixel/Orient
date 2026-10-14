'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createMemoryRoutes = require('../../src/interfaces/http/routes/memory.routes');
const JsonMemoryRepository = require('../../src/infrastructure/memory/json-memory.repository');
const MemoryService = require('../../src/application/memory/memory.service');

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    }
  };
}

test('memory page renders saved records after repository is reopened and keeps search on /memory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-page-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'memories.json');
  const context = { agentId: 'ORIENT_RUNTIME', tenantId: 'local' };
  const firstService = new MemoryService(new JsonMemoryRepository(file));
  const saved = firstService.add('ذاكرة اختبار بعد إعادة التشغيل', {}, context);
  assert.ok(saved.id);

  // Simulate a process restart by creating a new repository/service over the same file.
  const restartedService = new MemoryService(new JsonMemoryRepository(file));
  const routes = createMemoryRoutes(restartedService, { appName: 'ORIENT', version: 'test', defaultTenantId: 'local' });
  const response = responseRecorder();
  routes.home({}, response, new URL('http://localhost/memory'));

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /ذاكرة اختبار بعد إعادة التشغيل/);
  assert.match(response.body, /method="GET" action="\/memory"/);
  assert.match(response.body, /action="\/memory\/add"/);
});

test('memory add and delete redirects return to the memory page, not the public landing page', () => {
  const calls = [];
  const service = {
    add(text, options, context) { calls.push({ operation: 'add', text, context }); return { id: 'memory-1' }; },
    delete(id, context) { calls.push({ operation: 'delete', id, context }); return true; },
    list() { return []; }
  };
  const routes = createMemoryRoutes(service, { appName: 'ORIENT', version: 'test', defaultTenantId: 'local' });

  const addResponse = responseRecorder();
  routes.add({}, addResponse, new URLSearchParams({ text: 'persist this' }).toString());
  assert.equal(addResponse.statusCode, 303);
  assert.equal(addResponse.headers.Location, '/memory');

  const deleteResponse = responseRecorder();
  routes.delete({}, deleteResponse, new URLSearchParams({ id: 'memory-1' }).toString());
  assert.equal(deleteResponse.statusCode, 303);
  assert.equal(deleteResponse.headers.Location, '/memory');
  assert.deepEqual(calls.map(call => call.operation), ['add', 'delete']);
});

test('dashboard memory navigation points to the authenticated memory route', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '../../src/interfaces/http/dashboard.html'), 'utf8');
  assert.match(dashboard, /href="\/memory"[^>]*>فتح واجهة الذاكرة/);
  assert.doesNotMatch(dashboard, /href="\/"[^>]*>فتح واجهة الذاكرة/);
});
