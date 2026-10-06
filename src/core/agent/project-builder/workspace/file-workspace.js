const fs = require('fs/promises');
const path = require('path');

class FileWorkspace {
  constructor({ policy }) {
    if (!policy) {
      throw new TypeError('policy is required');
    }

    this.policy = policy;
  }

  async exists(relativePath) {
    const target =
      this.policy.assertRead(relativePath);

    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async readText(relativePath) {
    const target =
      this.policy.assertRead(relativePath);

    return fs.readFile(target, 'utf8');
  }

  async list(relativePath = '.') {
    const target =
      this.policy.assertRead(relativePath);

    return fs.readdir(
      target,
      { withFileTypes: true }
    );
  }

  async writeText(relativePath, content) {
    const target =
      this.policy.assertWrite(relativePath);

    await fs.mkdir(path.dirname(target), { recursive: true });

    await fs.writeFile(
      target,
      content,
      'utf8'
    );

    return target;
  }

  async removeFile(relativePath) {
    const target =
      this.policy.assertWrite(relativePath);

    await fs.unlink(target);

    return target;
  }
}

module.exports = FileWorkspace;
