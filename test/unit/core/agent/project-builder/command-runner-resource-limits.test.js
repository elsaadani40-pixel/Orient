'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const CommandRunner = require('../../../../../src/core/agent/project-builder/workspace/command-runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function createPolicy(overrides = {}) {
  return {
    allowedRoot: '/tmp/orient-test',
    environment: {},
    maxOutput: 1024,
    timeoutMs: 1000,
    resourceLimits: { maxOutputBytes: 1024 },
    assertCommand: () => '/usr/bin/node',
    resolve: () => '/tmp/orient-test',
    ...overrides
  };
}

test('command runner kills and rejects a command that exceeds its captured-output byte budget', async () => {
  const child = fakeChild();
  let terminated = false;
  const runner = new CommandRunner({
    policy: createPolicy(),
    isolator: {
      spawn: options => {
        assert.deepEqual(options.resourceLimits, { maxOutputBytes: 1024 });
        return child;
      },
      terminate: async () => { terminated = true; }
    }
  });

  const execution = runner.run('node');
  child.stdout.write(Buffer.alloc(1025, 65));

  await assert.rejects(execution, error => {
    assert.equal(error.code, 'OUTPUT_LIMIT_EXCEEDED');
    assert.equal(error.details.outputLimitBytes, 1024);
    assert.equal(error.details.observedOutputBytes, 1025);
    return true;
  });
  assert.equal(terminated, true);
});

test('command runner reports a structured timeout and requests process-tree termination', async () => {
  const child = fakeChild();
  let terminated = false;
  const runner = new CommandRunner({
    policy: createPolicy({ timeoutMs: 15 }),
    isolator: {
      spawn: () => child,
      terminate: async () => { terminated = true; }
    }
  });

  await assert.rejects(runner.run('node'), error => {
    assert.equal(error.code, 'COMMAND_TIMEOUT');
    assert.equal(error.details.timeoutMs, 15);
    return true;
  });
  assert.equal(terminated, true);
});

test('command runner surfaces systemd cgroup OOM as a distinct structured failure', async () => {
  const child = fakeChild();
  const runner = new CommandRunner({
    policy: createPolicy(),
    isolator: {
      spawn: () => child,
      inspect: async () => ({
        result: 'oom-kill',
        mainCode: 'killed',
        mainStatus: '9',
        enforcedProperties: {
          memoryMax: '268435456',
          cpuQuotaPerSecUSec: '1000000',
          tasksMax: '64',
          limitNoFile: '256',
          limitFSize: '67108864',
          runtimeMaxUSec: '30000000000'
        }
      }),
      cleanup: async () => true
    }
  });

  const execution = runner.run('node');
  child.emit('close', 1, null);
  const result = await execution;
  assert.equal(result.failureCode, 'MEMORY_LIMIT_EXCEEDED');
  assert.equal(result.resourceLimitStatus.enforcedProperties.memoryMax, '268435456');
});
