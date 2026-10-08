const fs = require('fs/promises');
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
    return this.policy.writeFile(
      relativePath,
      content
    );
  }

  async removeFile(relativePath) {
    return this.policy.removeFile(
      relativePath
    );
  }
}

module.exports = FileWorkspace;
