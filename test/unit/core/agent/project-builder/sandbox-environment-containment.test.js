const test = require('node:test');
const assert = require('node:assert/strict');
const WorkspacePolicy = require('../../../../../src/core/agent/project-builder/workspace/workspace-policy');
const CommandRunner = require('../../../../../src/core/agent/project-builder/workspace/command-runner');
const TestCommandIsolator = require('./test-command-isolator');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('sandbox commands do not inherit host environment secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orient-env-'));
  const secretName = 'ORIENT_SANDBOX_SECRET_LEAK_TEST';
  const previousSecret = process.env[secretName];
  process.env[secretName] = 'must-not-reach-child';

  try {
    const policy = new WorkspacePolicy({
      allowedRoot: root,
      allowCommands: true,
      allowedCommands: ['node'],
      environment: { ORIENT_SANDBOX: '1' }
    });
    const runner = new CommandRunner({ policy, isolator: new TestCommandIsolator() });
    const result = await runner.run(process.execPath, {
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({
          sandbox: process.env.ORIENT_SANDBOX,
          secret: process.env[${JSON.stringify(secretName)}] || null
        }))`
      ]
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sandbox: '1',
      secret: null
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env[secretName];
    } else {
      process.env[secretName] = previousSecret;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
