'use strict';

const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  memoryMaxBytes: 256 * 1024 * 1024,
  cpuQuotaPercent: 100,
  maxCpuTimeSeconds: 10,
  maxProcesses: 64,
  maxOpenFiles: 256,
  maxFileSizeBytes: 64 * 1024 * 1024,
  maxOutputBytes: 20_000
});

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_RESOURCE_LIMITS));

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeResourceLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('resourceLimits must be an object');
  }

  for (const key of Object.keys(overrides)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new TypeError(`Unknown project-builder resource limit: ${key}`);
    }
  }

  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...overrides };
  return Object.freeze({
    memoryMaxBytes: positiveInteger(limits.memoryMaxBytes, 'memoryMaxBytes', { min: 16 * 1024 * 1024 }),
    cpuQuotaPercent: positiveInteger(limits.cpuQuotaPercent, 'cpuQuotaPercent', { min: 1, max: 1000 }),
    maxCpuTimeSeconds: positiveInteger(limits.maxCpuTimeSeconds, 'maxCpuTimeSeconds', { min: 1, max: 3600 }),
    maxProcesses: positiveInteger(limits.maxProcesses, 'maxProcesses', { min: 1, max: 4096 }),
    maxOpenFiles: positiveInteger(limits.maxOpenFiles, 'maxOpenFiles', { min: 16, max: 65536 }),
    maxFileSizeBytes: positiveInteger(limits.maxFileSizeBytes, 'maxFileSizeBytes', { min: 1024 }),
    maxOutputBytes: positiveInteger(limits.maxOutputBytes, 'maxOutputBytes', { min: 1024 })
  });
}

function buildSystemdRunArgs({ unitName, timeoutMs, limits, executable, args = [] }) {
  if (typeof unitName !== 'string' || !/^orient-pb-[a-f0-9-]{16,64}\.service$/.test(unitName)) {
    throw new TypeError('unitName must be a generated ORIENT Project Builder service unit name');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new TypeError('executable is required');
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }

  const normalized = normalizeResourceLimits(limits);
  const runtimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

  return [
    '--user',
    '--quiet',
    '--wait',
    '--pipe',
    '--service-type=exec',
    `--unit=${unitName}`,
    `--property=CPUQuota=${normalized.cpuQuotaPercent}%`,
    `--property=LimitCPU=${normalized.maxCpuTimeSeconds}`,
    `--property=MemoryMax=${normalized.memoryMaxBytes}`,
    '--property=MemorySwapMax=0',
    `--property=TasksMax=${normalized.maxProcesses}`,
    `--property=LimitNOFILE=${normalized.maxOpenFiles}`,
    `--property=LimitFSIZE=${normalized.maxFileSizeBytes}`,
    `--property=RuntimeMaxSec=${runtimeSeconds}s`,
    '--property=KillMode=control-group',
    '--property=OOMPolicy=kill',
    '--',
    executable,
    ...args
  ];
}

module.exports = {
  DEFAULT_RESOURCE_LIMITS,
  normalizeResourceLimits,
  buildSystemdRunArgs
};
