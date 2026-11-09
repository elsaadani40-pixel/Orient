'use strict';

const { spawn } = require('node:child_process');

const ALLOWED_TOOLS = new Set([
  'get_system_health',
  'list_bots',
  'list_channels',
  'list_available_models'
]);
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;

function buildChildEnvironment(source = process.env) {
  const allowed = [
    'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA',
    'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'ELECTRON_RUN_AS_NODE', 'OPENMAUSBOT_URL', 'OMB_PORT',
    'OPENMAUSBOT_TOKEN', 'OPENMAUSBOT_MCP_TIMEOUT_MS'
  ];
  const result = {};
  const sourceKeys = new Map(Object.keys(source).map(key => [key.toLowerCase(), key]));
  for (const key of ['PATH', ...allowed]) {
    const sourceKey = sourceKeys.get(key.toLowerCase());
    if (sourceKey && typeof source[sourceKey] === 'string' && source[sourceKey].length > 0) {
      result[key] = source[sourceKey];
    }
  }
  return result;
}

class McpStdioSession {
  constructor(child, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.closed = false;

    child.stdout.on('data', chunk => this.consume(chunk));
    child.stdout.on('error', error => this.failAll(error));
    child.stdin.on('error', error => this.failAll(error));
    child.once('error', error => this.failAll(error));
    child.once('exit', (code, signal) => {
      this.failAll(Object.assign(
        new Error('OpenMausBot MCP process exited before completing the request'),
        { code: 'OPENMAUSBOT_MCP_PROCESS_EXITED', exitCode: code, signal }
      ));
    });
  }

  consume(chunk) {
    this.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES && !this.buffer.includes('\n')) {
      this.failAll(Object.assign(new Error('OpenMausBot MCP frame exceeded the size limit'), {
        code: 'OPENMAUSBOT_MCP_FRAME_TOO_LARGE'
      }));
      this.child.kill('SIGTERM');
      return;
    }

    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        this.failAll(Object.assign(new Error('OpenMausBot MCP frame exceeded the size limit'), {
          code: 'OPENMAUSBOT_MCP_FRAME_TOO_LARGE'
        }));
        this.child.kill('SIGTERM');
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(Object.assign(new Error('OpenMausBot MCP returned malformed JSON-RPC data'), {
          code: 'OPENMAUSBOT_MCP_PROTOCOL_ERROR'
        }));
        this.child.kill('SIGTERM');
        return;
      }
      if (!message || !Number.isInteger(message.id)) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(Object.assign(new Error('OpenMausBot MCP request failed'), {
          code: 'OPENMAUSBOT_MCP_REMOTE_ERROR',
          remoteCode: Number.isInteger(message.error.code) ? message.error.code : null
        }));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error('OpenMausBot MCP session is closed'), {
        code: 'OPENMAUSBOT_MCP_SESSION_CLOSED'
      }));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      return Promise.reject(Object.assign(new Error('OpenMausBot MCP request exceeded the size limit'), {
        code: 'OPENMAUSBOT_MCP_FRAME_TOO_LARGE'
      }));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('OpenMausBot MCP request timed out'), {
          code: 'OPENMAUSBOT_MCP_TIMEOUT'
        }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame, error => {
        if (!error || !this.pending.has(id)) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(Object.assign(new Error('Could not write to OpenMausBot MCP process'), {
          code: 'OPENMAUSBOT_MCP_WRITE_FAILED'
        }));
      });
    });
  }

  notify(method, params = {}) {
    if (this.closed) return;
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    if (Buffer.byteLength(frame, 'utf8') <= MAX_FRAME_BYTES) this.child.stdin.write(frame);
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orient-openmausbot-adapter', version: '0.1.0' }
    });
    if (!result || typeof result !== 'object' || typeof result.protocolVersion !== 'string') {
      throw Object.assign(new Error('OpenMausBot MCP initialization response is invalid'), {
        code: 'OPENMAUSBOT_MCP_PROTOCOL_ERROR'
      });
    }
    this.notify('notifications/initialized');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(Object.assign(new Error('OpenMausBot MCP session closed'), {
      code: 'OPENMAUSBOT_MCP_SESSION_CLOSED'
    }));
    try { this.child.stdin.end(); } catch (_) {}
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { this.child.kill('SIGTERM'); } catch (_) { return; }
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { this.child.kill('SIGKILL'); } catch (_) {}
        finish();
      }, 500);
      this.child.once('exit', finish);
    });
  }
}

class OpenMausBotMcpClient {
  constructor({
    command = 'openmausbot',
    args = ['mcp'],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxConcurrent = 2,
    spawnImpl = spawn,
    env = process.env
  } = {}) {
    if (typeof command !== 'string' || !command.trim()) {
      throw new TypeError('OpenMausBot MCP command is required');
    }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      throw new TypeError('OpenMausBot MCP arguments must be an array of strings');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError('OpenMausBot MCP timeout must be between 1000 and 120000 milliseconds');
    }
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
      throw new RangeError('OpenMausBot MCP maxConcurrent must be between 1 and 8');
    }
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');

    this.command = command;
    this.args = [...args];
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.activeCalls = 0;
    this.spawn = spawnImpl;
    this.env = buildChildEnvironment(env);
  }

  async callTool(name, input = {}) {
    if (!ALLOWED_TOOLS.has(name)) {
      throw Object.assign(new Error('OpenMausBot MCP tool is not in the ORIENT read-only allowlist'), {
        code: 'OPENMAUSBOT_MCP_TOOL_NOT_ALLOWED'
      });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
      throw Object.assign(new Error('This OpenMausBot discovery operation accepts no input fields'), {
        code: 'OPENMAUSBOT_MCP_INPUT_INVALID'
      });
    }
    if (this.activeCalls >= this.maxConcurrent) {
      throw Object.assign(new Error('OpenMausBot MCP concurrency limit reached'), {
        code: 'OPENMAUSBOT_MCP_BUSY'
      });
    }

    this.activeCalls += 1;
    let session = null;
    try {
      const child = this.spawn(this.command, this.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: this.env
      });
      session = new McpStdioSession(child, { timeoutMs: this.timeoutMs });

      await session.initialize();
      const listed = await session.request('tools/list');
      if (!listed || !Array.isArray(listed.tools) ||
          !listed.tools.some(tool => tool?.name === 'get_system_health') ||
          !listed.tools.some(tool => tool?.name === name)) {
        throw Object.assign(new Error('The configured OpenMausBot server does not expose the expected read-only tool set'), {
          code: 'OPENMAUSBOT_MCP_TOOL_UNAVAILABLE'
        });
      }
      const health = await session.request('tools/call', {
        name: 'get_system_health',
        arguments: {}
      });
      if (!health || health.isError === true ||
          health.structuredContent?.app !== 'openmausbot') {
        throw Object.assign(new Error('The configured MCP endpoint did not identify itself as OpenMausBot'), {
          code: 'OPENMAUSBOT_MCP_IDENTITY_REJECTED'
        });
      }
      const result = name === 'get_system_health'
        ? health
        : await session.request('tools/call', { name, arguments: input });
      if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
        throw Object.assign(new Error('OpenMausBot MCP returned an invalid tool result'), {
          code: 'OPENMAUSBOT_MCP_RESPONSE_INVALID'
        });
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
        throw Object.assign(new Error('OpenMausBot MCP response exceeded the size limit'), {
          code: 'OPENMAUSBOT_MCP_RESPONSE_TOO_LARGE'
        });
      }
      if (result.isError === true) {
        throw Object.assign(new Error('OpenMausBot could not complete the read-only discovery request'), {
          code: 'OPENMAUSBOT_MCP_TOOL_FAILED'
        });
      }
      return Object.freeze({
        provider: 'openmausbot',
        tool: name,
        untrusted: true,
        result
      });
    } finally {
      try {
        if (session) await session.close();
      } finally {
        this.activeCalls -= 1;
      }
    }
  }
}

module.exports = {
  ALLOWED_TOOLS,
  OpenMausBotMcpClient,
  buildChildEnvironment
};
