'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const BubblewrapIsolator = require('../../../../../src/core/agent/project-builder/workspace/bubblewrap-isolator');

test('resource supervisor fails closed when cgroup v2 lacks a required controller', () => {
  let spawned = false;
  const isolator = new BubblewrapIsolator({
    platform: 'linux',
    readFileSync(file) {
      if (file === '/proc/self/cgroup') return '0::/user.slice/user-1000.slice/user@1000.service\n';
      if (file === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory';
      throw new Error('unexpected file');
    },
    spawnProcess() {
      spawned = true;
      throw new Error('must not start without pids controller');
    }
  });

  assert.throws(() => isolator.spawn({
    executable: '/usr/bin/node',
    args: ['-e', 'process.exit(0)'],
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    timeoutMs: 1000
  }), error => error.code === 'RESOURCE_LIMITS_UNAVAILABLE');
  assert.equal(spawned, false);
});

test('resource supervisor fails closed when the host is not using unified cgroup v2', () => {
  const isolator = new BubblewrapIsolator({
    platform: 'linux',
    readFileSync(file) {
      if (file === '/proc/self/cgroup') return '2:cpu:/user.slice\n';
      if (file === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids';
      throw new Error('unexpected file');
    },
    spawnProcess() {
      throw new Error('must not spawn without unified cgroup v2');
    }
  });

  assert.throws(() => isolator.spawn({
    executable: '/usr/bin/node',
    args: [],
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    timeoutMs: 1000
  }), error => error.code === 'RESOURCE_LIMITS_UNAVAILABLE');
});

function makeTerminationScenario({ failAt = null, activeState = 'inactive' } = {}) {
  const calls = [];
  const isolator = new BubblewrapIsolator({
    platform: 'linux',
    spawnProcess(command, args) {
      const action = args[1];
      calls.push(action === 'show' ? 'show' : action);
      const child = new EventEmitter();
      child.kill = () => true;
      if (action === 'show') {
        child.stdout = new PassThrough();
      }
      setImmediate(() => {
        const shouldFail = action === failAt;
        if (action === 'show' && !shouldFail) {
          child.stdout.write(`${activeState}\\n`);
          child.stdout.end();
        }
        child.emit('close', shouldFail ? 1 : 0);
      });
      return child;
    }
  });
  const child = {
    orientResourceUnitName: 'orient-pb-01234567-89ab-cdef-0123-456789abcdef.service',
    orientResourceEnvironment: {},
    orientSystemdEnvironment: {},
    kill: () => true
  };
  return { isolator, child, calls };
}

test('resource supervisor termination verifies inactive unit before resetting failure state', async () => {
  const { isolator, child, calls } = makeTerminationScenario();
  assert.equal(await isolator.terminate(child), true);
  assert.deepEqual(calls, ['kill', 'stop', 'show', 'reset-failed']);
});

for (const failedAction of ['kill', 'stop', 'reset-failed']) {
  test(`resource supervisor termination reports failure when systemctl ${failedAction} fails`, async () => {
    const { isolator, child, calls } = makeTerminationScenario({ failAt: failedAction });
    assert.equal(await isolator.terminate(child), false);
    assert.ok(calls.includes(failedAction));
    assert.ok(!calls.includes('reset-failed') || failedAction === 'reset-failed');
  });
}

test('resource supervisor termination reports failure when the unit remains active', async () => {
  const { isolator, child, calls } = makeTerminationScenario({ activeState: 'active' });
  assert.equal(await isolator.terminate(child), false);
  assert.deepEqual(calls, ['kill', 'stop', 'show']);
});

test('resource supervisor parses named systemd properties even when Result is empty for an active unit', async () => {
  const output = [
    'Result=',
    'ActiveState=active',
    'ExecMainCode=0',
    'ExecMainStatus=0',
    'MemoryMax=134217728',
    'CPUQuotaPerSecUSec=750000',
    'TasksMax=24',
    'LimitNOFILE=128',
    'LimitFSIZE=1048576',
    'RuntimeMaxUSec=2000000000',
    'LimitCPU=2',
    'LimitCPUSoft=1',
    'MemorySwapMax=0',
    ''
  ].join('\n');

  const isolator = new BubblewrapIsolator({
    platform: 'linux',
    spawnProcess(command, args) {
      assert.equal(command, 'systemctl');
      assert.ok(args.includes('--property=MemoryMax'));
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      setImmediate(() => {
        child.stdout.write(output);
        child.stdout.end();
        child.emit('close', 0);
      });
      return child;
    }
  });
  const child = {
    orientResourceUnitName: 'orient-pb-01234567-89ab-cdef-0123-456789abcdef.service',
    orientSystemdEnvironment: {}
  };

  const status = await isolator.inspect(child);
  assert.equal(status.result, 'running');
  assert.equal(status.enforcedProperties.memoryMax, '134217728');
  assert.equal(status.enforcedProperties.tasksMax, '24');
  assert.equal(status.enforcedProperties.limitCPUSoft, '1');
  assert.equal(status.enforcedProperties.memorySwapMax, '0');
});
