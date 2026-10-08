const path = require('path');
const fs = require('fs');

class WorkspacePolicy {
  constructor({
    allowedRoot,
    allowRead = true,
    allowWrite = false,
    allowCommands = false,
    allowGit = false,
    deniedCommands = [],
    allowedCommands = [],
    maxOutput = 20000,
    timeoutMs = 30000,
    environment = {}
  } = {}) {
    if (!allowedRoot || typeof allowedRoot !== 'string') {
      throw new TypeError('allowedRoot is required');
    }

    this.allowedRoot = path.resolve(allowedRoot);
    fs.mkdirSync(this.allowedRoot, { recursive: true });
    this.realAllowedRoot = fs.realpathSync.native(this.allowedRoot);
    this.allowRead = allowRead === true;
    this.allowWrite = allowWrite === true;
    this.allowCommands = allowCommands === true;
    this.allowGit = allowGit === true;
    this.deniedCommands = new Set(deniedCommands.map(String));
    this.allowedCommands = new Set(allowedCommands.map(String));
    this.maxOutput = Number.isFinite(maxOutput) && maxOutput > 0
      ? maxOutput
      : 20000;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : 30000;
    this.environment = Object.freeze(
      Object.fromEntries(
        Object.entries(environment || {}).map(([key, value]) => [
          String(key),
          String(value)
        ])
      )
    );
  }

  resolve(relativePath = '.') {
    if (typeof relativePath !== 'string') {
      throw new TypeError('path must be a string');
    }

    const resolved =
      path.resolve(this.allowedRoot, relativePath);

    if (
      resolved !== this.allowedRoot &&
      !resolved.startsWith(`${this.allowedRoot}${path.sep}`)
    ) {
      throw new Error('Workspace path escapes allowed root');
    }

    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }

    const realProbe = fs.realpathSync.native(probe);
    if (
      realProbe !== this.realAllowedRoot &&
      !realProbe.startsWith(`${this.realAllowedRoot}${path.sep}`)
    ) {
      throw new Error('Workspace path escapes allowed root');
    }

    return resolved;
  }

  assertRead(relativePath = '.') {
    if (!this.allowRead) {
      throw new Error(
        'Workspace read access is denied'
      );
    }

    return this.resolve(relativePath);
  }

  assertWrite(relativePath) {
    if (!this.allowWrite) {
      throw new Error(
        'Workspace write access is denied'
      );
    }

    const resolved = this.resolve(relativePath);

    if (fs.existsSync(resolved)) {
      const stats = fs.lstatSync(resolved);
      if (stats.isFile() && stats.nlink > 1) {
        throw new Error(
          'Workspace write target is a hardlink and is denied'
        );
      }
    }

    return resolved;
  }

  assertCommand(command) {
    if (!this.allowCommands) {
      throw new Error(
        'Workspace command execution is denied'
      );
    }

    const executable =
      String(command || '')
        .trim()
        .split(/\s+/)[0];

    if (!executable) {
      throw new Error('Command is required');
    }

    const executableName =
      path.basename(executable);

    if (
      this.allowedCommands.size === 0 ||
      !(
        this.allowedCommands.has(executable) ||
        this.allowedCommands.has(executableName)
      )
    ) {
      throw new Error(
        `Command "${executable}" is not allowed`
      );
    }

    if (this.deniedCommands.has(executable)) {
      throw new Error(
        `Command "${executable}" is denied`
      );
    }

    if (
      !this.allowGit &&
      (executable === 'git' ||
       executable.endsWith('/git'))
    ) {
      throw new Error(
        'Git command execution is denied'
      );
    }

    return executable;
  }
}

module.exports = WorkspacePolicy;
