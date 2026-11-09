'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  ALLOWED_TOOLS,
  OpenMausBotMcpClient,
  buildChildEnvironment
} = require('../../../../src/infrastructure/agents/openmausbot-mcp-client');

class FakeMcpChild extends EventEmitter {
  constructor({ availableTools = [...ALLOWED_TOOLS], failMethod = null, malformed = false } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stdin = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.requests = [];
    this.availableTools = availableTools;
    this.failMethod = failMethod;
    this.malformed = malformed;
    let buffer = '';
    this.stdin.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        this.requests.push(request);
        if (!Object.hasOwn(request, 'id')) continue;
        if (request.method === this.failMethod) continue;
        if (this.malformed) {
          this.stdout.write('not-json\n');
          continue;
        }
        let result = {};
        if (request.method === 'initialize') {
          result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'openmausbot', version: 'test' } };
        } else if (request.method === 'tools/list') {
          result = { tools: this.availableTools.map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) };
        } else if (request.method === 'tools/call') {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, name: request.params.name }) }] };
        }
        this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }
    });
  }

  kill(signal) {
    this.signalCode = signal;
    process.nextTick(() => this.emit('exit', null, signal));
    return true;
  }
}

test('OpenMausBot MCP client initializes and calls only the expected read-only tool', async () => {
  let child;
  let spawnArgs;
  const client = new OpenMausBotMcpClient({
    command: '/opt/openmausbot',
    args: ['mcp'],
    spawnImpl: (command, args, options) => {
      spawnArgs = { command, args, options };
      child = new FakeMcpChild();
      return child;
    },
    env: { PATH: '/usr/bin', HOME: '/home/orient', OPENMAUSBOT_TOKEN: 'test-token', DATABASE_URL: 'must-not-leak' }
  });

  const result = await client.callTool('list_bots');

  assert.equal(result.provider, 'openmausbot');
  assert.equal(result.tool, 'list_bots');
  assert.equal(result.untrusted, true);
  assert.equal(result.result.content[0].type, 'text');
  assert.deepEqual(spawnArgs.args, ['mcp']);
  assert.equal(spawnArgs.options.shell, false);
  assert.equal(spawnArgs.options.env.OPENMAUSBOT_TOKEN, 'test-token');
  assert.equal(spawnArgs.options.env.DATABASE_URL, undefined);
  assert.ok(child.requests.some(request => request.method === 'notifications/initialized'));
  assert.ok(child.requests.some(request => request.method === 'tools/call' && request.params.name === 'list_bots'));
  assert.equal(child.signalCode, 'SIGTERM');
});

test('OpenMausBot MCP client rejects unapproved upstream tools before spawning', async () => {
  let spawned = false;
  const client = new OpenMausBotMcpClient({
    spawnImpl: () => { spawned = true; throw new Error('must not spawn'); }
  });
  await assert.rejects(client.callTool('send_bot_message'), {
    code: 'OPENMAUSBOT_MCP_TOOL_NOT_ALLOWED'
  });
  assert.equal(spawned, false);
});

test('OpenMausBot MCP client rejects input fields on fixed discovery operations', async () => {
  let spawned = false;
  const client = new OpenMausBotMcpClient({
    spawnImpl: () => { spawned = true; throw new Error('must not spawn'); }
  });
  await assert.rejects(client.callTool('list_bots', { tenantId: 'attacker' }), {
    code: 'OPENMAUSBOT_MCP_INPUT_INVALID'
  });
  assert.equal(spawned, false);
});

test('OpenMausBot MCP client fails closed when an expected tool is absent', async () => {
  const client = new OpenMausBotMcpClient({
    spawnImpl: () => new FakeMcpChild({ availableTools: ['get_system_health'] })
  });
  await assert.rejects(client.callTool('list_bots'), {
    code: 'OPENMAUSBOT_MCP_TOOL_UNAVAILABLE'
  });
});

test('OpenMausBot MCP client rejects malformed JSON-RPC output', async () => {
  const client = new OpenMausBotMcpClient({
    spawnImpl: () => new FakeMcpChild({ malformed: true })
  });
  await assert.rejects(client.callTool('get_system_health'), {
    code: 'OPENMAUSBOT_MCP_PROTOCOL_ERROR'
  });
});

test('OpenMausBot MCP client rejects invalid command and timeout configuration', () => {
  assert.throws(() => new OpenMausBotMcpClient({ command: ' ' }), /command is required/);
  assert.throws(() => new OpenMausBotMcpClient({ timeoutMs: 999 }), /between 1000 and 120000/);
  assert.throws(() => new OpenMausBotMcpClient({ args: 'mcp' }), /array of strings/);
});

test('OpenMausBot child environment excludes unrelated ORIENT secrets', () => {
  assert.deepEqual(buildChildEnvironment({
    PATH: '/bin',
    HOME: '/home/orient',
    OPENMAUSBOT_TOKEN: 'paired-token',
    DATABASE_URL: 'postgres://secret',
    ORIENT_OWNER_PASSWORD: 'owner-secret',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret'
  }), {
    PATH: '/bin',
    HOME: '/home/orient',
    OPENMAUSBOT_TOKEN: 'paired-token'
  });
});
