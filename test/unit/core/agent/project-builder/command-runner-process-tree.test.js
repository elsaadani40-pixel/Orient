const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const CommandRunner =
  require('../../../../../src/core/agent/project-builder/workspace/command-runner');

const TestCommandIsolator = require('./test-command-isolator');

const WorkspacePolicy =
  require('../../../../../src/core/agent/project-builder/workspace/workspace-policy');

test('timeout terminates the complete child process group on POSIX', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'orient-command-tree-')
  );
  const pidFile = path.join(root, 'grandchild.pid');

  const policy = new WorkspacePolicy({
    allowedRoot: root,
    allowCommands: true,
    allowedCommands: ['node'],
    timeoutMs: 150
  });

  const runner = new CommandRunner({ policy, isolator: new TestCommandIsolator() });

  await assert.rejects(
    () => runner.run(process.execPath, {
      cwd: '.',
      args: [
        '-e',
        [
          "const fs=require('fs');",
          "const {spawn}=require('child_process');",
          "const out=process.argv[1];",
          "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
          "fs.writeFileSync(out,String(child.pid));",
          "setInterval(()=>{},1000);"
        ].join(''),
        pidFile
      ]
    }),
    /Command timed out/
  );

  const grandchildPid = Number(
    await fs.readFile(pidFile, 'utf8')
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(grandchildPid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      await fs.rm(root, { recursive: true, force: true });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  await fs.rm(root, { recursive: true, force: true });
  assert.fail('timed-out command left a descendant process running');
});

// Regression remains intentionally POSIX-scoped.
