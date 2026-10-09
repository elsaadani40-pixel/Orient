// Test-only process adapter. Production code must use BubblewrapIsolator.
const { spawn } = require('node:child_process');

class TestCommandIsolator {
  spawn({ executable, args = [], workspaceRoot, cwd, environment = {} }) {
    return spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH || '',
        ...environment
      }
    });
  }
}

module.exports = TestCommandIsolator;
