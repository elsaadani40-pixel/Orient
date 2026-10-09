const test = require('node:test');
const assert = require('node:assert/strict');

const createServer = require('../../src/interfaces/http/server');

test('dashboard route serves the local control UI with security headers', async (t) => {
  const server = createServer({
    memoryRoutes: {
      home(_req, res) { res.writeHead(200); res.end('memory'); },
      add() {},
      delete() {}
    },
    agentRoutes: {}
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html; charset=utf-8/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(html, /ORIENT ONE/);
  assert.match(html, /fetch\('\/agent'/);
  assert.match(html, /تعذر الاتصال بالخادم/);
});

test('WebGL command scene is served locally with a JavaScript content type', async (t) => {
  const server = createServer({
    memoryRoutes: { home(_req, res) { res.writeHead(200); res.end('memory'); }, add() {}, delete() {} },
    agentRoutes: {}
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/command-scene.js`);
  const source = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/javascript; charset=utf-8/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(source, /getContext\('webgl'/);
  assert.match(source, /CSS FALLBACK/);
});

test('dashboard does not replace the existing memory home route', async (t) => {
  const server = createServer({
    memoryRoutes: {
      home(_req, res) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('existing-memory-home'); },
      add() {},
      delete() {}
    },
    agentRoutes: {}
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'existing-memory-home');
});
