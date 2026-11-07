'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnsandboxedExecutionEnabled } =
  require('../../../../../src/core/agent/project-builder/workspace/unsandboxed-execution-policy');

test('explicit opt-in is accepted only on macOS and Windows', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(isUnsandboxedExecutionEnabled({
      platform,
      env: { ORIENT_ALLOW_UNSANDBOXED: '1' }
    }), true);
  }
});

test('Linux remains sandbox-only even when the non-Linux opt-in variable is set', () => {
  assert.equal(isUnsandboxedExecutionEnabled({
    platform: 'linux',
    env: { ORIENT_ALLOW_UNSANDBOXED: '1' }
  }), false);
});

test('missing, malformed, or unsupported opt-in values remain fail-closed', () => {
  for (const value of [undefined, '', 'true', 'yes', '0']) {
    assert.equal(isUnsandboxedExecutionEnabled({
      platform: 'darwin',
      env: { ORIENT_ALLOW_UNSANDBOXED: value }
    }), false);
  }
  assert.equal(isUnsandboxedExecutionEnabled({
    platform: 'freebsd',
    env: { ORIENT_ALLOW_UNSANDBOXED: '1' }
  }), false);
});
