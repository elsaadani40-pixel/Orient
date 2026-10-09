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


test('command runner distinguishes a CPU-time SIGXCPU status encoded by systemd', async () => {
  const child = fakeChild();
  const runner = new CommandRunner({
    policy: createPolicy(),
    isolator: {
      spawn: () => child,
      inspect: async () => ({
        result: 'exit-code',
        mainCode: '1',
        mainStatus: '152',
        enforcedProperties: { limitCPU: '2', limitCPUSoft: '1' }
      }),
      cleanup: async () => true
    }
  });

  const execution = runner.run('node');
  child.emit('close', 152, null);
  const result = await execution;
  assert.equal(result.failureCode, 'CPU_LIMIT_EXCEEDED');
});

test('command runner distinguishes a file-size SIGXFSZ status encoded by systemd', async () => {
  const child = fakeChild();
  const runner = new CommandRunner({
    policy: createPolicy(),
    isolator: {
      spawn: () => child,
      inspect: async () => ({
        result: 'exit-code',
        mainCode: '1',
        mainStatus: '153',
        enforcedProperties: { limitFSize: '1048576' }
      }),
      cleanup: async () => true
    }
  });

  const execution = runner.run('node');
  child.emit('close', 153, null);
  const result = await execution;
  assert.equal(result.failureCode, 'FILE_SIZE_LIMIT_EXCEEDED');
});

test('command runner captures terminal systemd status after a successful command exit', async () => {
  const child = fakeChild();
  child.orientInitialInspection = Promise.resolve({
    result: 'running',
    activeState: 'active',
    enforcedProperties: { memoryMax: '268435456' }
  });
  let inspections = 0;
  let cleaned = false;
  const runner = new CommandRunner({
    policy: createPolicy(),
    isolator: {
      spawn: () => child,
      inspect: async () => {
        inspections += 1;
        return {
          result: 'success',
          activeState: 'inactive',
          mainStatus: '0',
          enforcedProperties: { memoryMax: 'infinity' }
        };
      },
      cleanup: async () => { cleaned = true; return true; }
    }
  });

  const execution = runner.run('node');
  child.emit('close', 0, null);
  const result = await execution;

  assert.equal(inspections, 1, 'terminal systemd state must be inspected after the initial snapshot');
  assert.equal(cleaned, true);
  assert.equal(result.failureCode, null);
  assert.equal(result.resourceLimitStatus.result, 'success');
  assert.equal(result.resourceLimitStatus.activeState, 'inactive');
  assert.equal(result.resourceLimitStatus.enforcedProperties.memoryMax, '268435456');
});


test('command runner fails closed when a systemd command has no verified initial quota snapshot', async () => {
  const child = fakeChild();
  child.orientResourceUnitName = 'orient-pb-0123456789abcdef.service';
  child.orientInitialInspection = Promise.resolve(null);
  const limits = {
    memoryMaxBytes: 268435456,
    cpuQuotaPercent: 100,
    maxCpuTimeSeconds: 10,
    maxProcesses: 64,
    maxOpenFiles: 256,
    maxFileSizeBytes: 67108864,
    maxOutputBytes: 1024
  };
  const runner = new CommandRunner({
    policy: createPolicy({ timeoutMs: 10000, resourceLimits: limits }),
    isolator: {
      spawn: () => child,
      inspect: async () => ({
        result: 'success',
        activeState: 'inactive',
        mainStatus: '0',
        enforcedProperties: {
          memoryMax: 'infinity',
          cpuQuotaPerSecUSec: 'infinity',
          tasksMax: 'infinity',
          limitNoFile: 'infinity',
          limitFSize: 'infinity',
          runtimeMaxUSec: 'infinity',
          limitCPU: 'infinity',
          limitCPUSoft: 'infinity',
          memorySwapMax: 'infinity'
        }
      }),
      cleanup: async () => true
    }
  });

  const execution = runner.run('node');
  child.emit('close', 0, null);
  const result = await execution;

  assert.equal(result.code, 0);
  assert.equal(result.resourceLimitsVerified, false);
  assert.equal(result.failureCode, 'RESOURCE_LIMITS_UNAVAILABLE');
});
