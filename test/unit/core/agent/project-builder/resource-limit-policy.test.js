'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RESOURCE_LIMITS,
  normalizeResourceLimits,
  buildSystemdRunArgs
} = require('../../../../../src/core/agent/project-builder/workspace/resource-limit-policy');

test('resource limits have conservative OS-enforceable defaults', () => {
  const limits = normalizeResourceLimits();
  assert.deepEqual(limits, DEFAULT_RESOURCE_LIMITS);
  assert.ok(limits.memoryMaxBytes > 0);
  assert.ok(limits.maxProcesses > 0);
  assert.ok(limits.maxOpenFiles > 0);
  assert.ok(limits.maxFileSizeBytes > 0);
  assert.ok(limits.maxOutputBytes > 0);
});

test('resource limit policy rejects unknown and unsafe values instead of silently defaulting', () => {
  assert.throws(() => normalizeResourceLimits({ memoryMaxBytes: 0 }), /memoryMaxBytes/);
  assert.throws(() => normalizeResourceLimits({ maxProcesses: 1.5 }), /maxProcesses/);
  assert.throws(() => normalizeResourceLimits({ cpuQuotaPercent: 1001 }), /cpuQuotaPercent/);
  assert.throws(() => normalizeResourceLimits({ maxCpuTimeSeconds: 0 }), /maxCpuTimeSeconds/);
  assert.throws(() => normalizeResourceLimits({ memroyMaxBytes: 10 }), /Unknown project-builder resource limit/);
  assert.throws(() => normalizeResourceLimits(null), /resourceLimits must be an object/);
});

test('systemd runner args set cgroup-wide limits, file descriptor/file size limits and a runtime ceiling', () => {
  const args = buildSystemdRunArgs({
    unitName: 'orient-pb-01234567-89ab-cdef-0123-456789abcdef.service',
    timeoutMs: 1501,
    limits: {
      memoryMaxBytes: 134217728,
      cpuQuotaPercent: 75,
      maxCpuTimeSeconds: 2,
      maxProcesses: 24,
      maxOpenFiles: 128,
      maxFileSizeBytes: 1048576
    },
    executable: '/usr/bin/bwrap',
    args: ['--unshare-all', '--', '/usr/bin/node', '-e', 'process.exit(0)']
  });

  assert.ok(args.includes('--property=CPUQuota=75%'));
  assert.ok(args.includes('--property=LimitCPU=2'));
  assert.ok(args.includes('--property=MemorySwapMax=0'));
  assert.ok(args.includes('--property=MemoryMax=134217728'));
  assert.ok(args.includes('--property=TasksMax=24'));
  assert.ok(args.includes('--property=LimitNOFILE=128'));
  assert.ok(args.includes('--property=LimitFSIZE=1048576'));
  assert.ok(args.includes('--property=RuntimeMaxSec=2s'));
  assert.ok(args.includes('--property=KillMode=control-group'));
  assert.ok(args.includes('--property=OOMPolicy=kill'));
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('--wait'));
  assert.ok(args.includes('--pipe'));
  assert.equal(args.at(-1), 'process.exit(0)');
});

test('systemd runner arguments reject malformed unit names and non-string command arguments', () => {
  const common = {
    timeoutMs: 1000,
    limits: DEFAULT_RESOURCE_LIMITS,
    executable: '/usr/bin/bwrap',
    args: []
  };
  assert.throws(() => buildSystemdRunArgs({ ...common, unitName: 'untrusted.service' }), /unitName/);
  assert.throws(() => buildSystemdRunArgs({
    ...common,
    unitName: 'orient-pb-01234567-89ab-cdef-0123-456789abcdef.service',
    args: ['ok', 7]
  }), /array of strings/);
});
