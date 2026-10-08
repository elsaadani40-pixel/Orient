const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSandboxPolicy,
  emptySandboxPolicy
} = require('../../../../src/core/security/sandbox/sandbox-policy');

test('sandbox policy is deny-by-default for writes and network', () => {
  const policy = emptySandboxPolicy();

  assert.deepEqual(policy.filesystem.allowWrite, []);
  assert.deepEqual(policy.network.allowedDomains, []);
});

test('sandbox policy normalizes duplicate entries without weakening restrictions', () => {
  const policy = createSandboxPolicy({
    filesystem: {
      allowRead: ['workspace', 'workspace', ''],
      denyRead: ['secrets'],
      allowWrite: ['workspace'],
      denyWrite: ['workspace/secrets']
    },
    network: {
      allowedDomains: ['example.com', 'example.com']
    }
  });

  assert.deepEqual(policy.filesystem.allowRead, ['workspace']);
  assert.deepEqual(policy.filesystem.denyRead, ['secrets']);
  assert.deepEqual(policy.filesystem.allowWrite, ['workspace']);
  assert.deepEqual(policy.filesystem.denyWrite, ['workspace/secrets']);
  assert.deepEqual(policy.network.allowedDomains, ['example.com']);
});

test('sandbox policy rejects malformed lists', () => {
  assert.throws(
    () => createSandboxPolicy({
      network: { allowedDomains: 'example.com' }
    }),
    /must be arrays/
  );
});
