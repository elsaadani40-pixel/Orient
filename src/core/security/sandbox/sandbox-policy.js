'use strict';

const DEFAULT_PROFILE = Object.freeze({
  filesystem: Object.freeze({
    allowRead: Object.freeze([]),
    denyRead: Object.freeze([]),
    allowWrite: Object.freeze([]),
    denyWrite: Object.freeze([])
  }),
  network: Object.freeze({
    allowedDomains: Object.freeze([])
  }),
  unixSockets: Object.freeze({
    allowed: Object.freeze([])
  })
});

function normalizeList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('Sandbox policy lists must be arrays');
  }
  return [...new Set(value.filter(
    item => typeof item === 'string' && item.trim()
  ))];
}

function createSandboxPolicy(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Sandbox policy must be an object');
  }

  const filesystem = input.filesystem || {};
  const network = input.network || {};
  const unixSockets = input.unixSockets || {};

  return Object.freeze({
    filesystem: Object.freeze({
      allowRead: Object.freeze(normalizeList(filesystem.allowRead)),
      denyRead: Object.freeze(normalizeList(filesystem.denyRead)),
      allowWrite: Object.freeze(normalizeList(filesystem.allowWrite)),
      denyWrite: Object.freeze(normalizeList(filesystem.denyWrite))
    }),
    network: Object.freeze({
      allowedDomains: Object.freeze(normalizeList(network.allowedDomains))
    }),
    unixSockets: Object.freeze({
      allowed: Object.freeze(normalizeList(unixSockets.allowed))
    })
  });
}

function emptySandboxPolicy() {
  return createSandboxPolicy(DEFAULT_PROFILE);
}

module.exports = {
  createSandboxPolicy,
  emptySandboxPolicy
};
