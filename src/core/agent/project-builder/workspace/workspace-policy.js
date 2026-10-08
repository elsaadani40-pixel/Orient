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

  _assertNoSymlinkComponents(resolved) {
    let current = this.allowedRoot;
    const relative = path.relative(this.allowedRoot, resolved);
    const parts = relative ? relative.split(path.sep) : [];

    for (const part of parts) {
      current = path.join(current, part);
      let stats;
      try {
        stats = fs.lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new Error(
          'Workspace write path contains a symbolic link and is denied'
        );
      }
    }
  }

  assertWrite(relativePath) {
    if (!this.allowWrite) {
      throw new Error(
        'Workspace write access is denied'
      );
    }

    const resolved = this.resolve(relativePath);
    this._assertNoSymlinkComponents(resolved);

    if (fs.existsSync(resolved)) {
      const stats = fs.lstatSync(resolved);
      if (stats.isSymbolicLink()) {
        throw new Error(
          'Workspace write target is a symbolic link and is denied'
        );
      }
      if (stats.isFile() && stats.nlink > 1) {
        throw new Error(
          'Workspace write target is a hardlink and is denied'
        );
      }
    }

    return resolved;
  }

  _openParentDirectory(resolved, { createMissing = false } = {}) {
    if (process.platform !== 'linux') return null;

    const rootFlags =
      fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY |
      fs.constants.O_NOFOLLOW;

    let fd = fs.openSync(this.realAllowedRoot, rootFlags);

    try {
      const relative = path.relative(this.realAllowedRoot, resolved);
      const parts = relative.split(path.sep).filter(Boolean);
      const parents = parts.slice(0, -1);

      for (const part of parents) {
        const candidate = `/proc/self/fd/${fd}/${part}`;

        if (createMissing) {
          try {
            fs.mkdirSync(candidate, { mode: 0o700 });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }

        const nextFd = fs.openSync(candidate, rootFlags);
        fs.closeSync(fd);
        fd = nextFd;
      }

      return {
        fd,
        path: `/proc/self/fd/${fd}`,
        basename: path.basename(resolved)
      };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  writeFile(relativePath, content) {
    if (typeof content !== 'string') {
      throw new TypeError('Workspace file content must be a string');
    }

    const resolved = this.assertWrite(relativePath);

    if (process.platform !== 'linux') {
      const parent = path.dirname(resolved);
      fs.mkdirSync(parent, { recursive: true });
      const temp = `${resolved}.orient-tmp-${process.pid}-${Date.now()}`;
      const fd = fs.openSync(
        temp,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, resolved);
      return resolved;
    }

    const parent = this._openParentDirectory(resolved, {
      createMissing: true
    });
    const tempName =
      `.orient-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempPath = `${parent.path}/${tempName}`;
    const targetPath = `${parent.path}/${parent.basename}`;
    let tempFd = null;

    try {
      tempFd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      fs.writeFileSync(tempFd, content, 'utf8');
      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempFd = null;
      fs.renameSync(tempPath, targetPath);
      return resolved;
    } finally {
      if (tempFd !== null) fs.closeSync(tempFd);
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.closeSync(parent.fd);
    }
  }

  removeFile(relativePath) {
    const resolved = this.assertWrite(relativePath);

    if (process.platform !== 'linux') {
      fs.unlinkSync(resolved);
      return resolved;
    }

    const parent = this._openParentDirectory(resolved);
    try {
      fs.unlinkSync(`${parent.path}/${parent.basename}`);
      return resolved;
    } finally {
      fs.closeSync(parent.fd);
    }
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
