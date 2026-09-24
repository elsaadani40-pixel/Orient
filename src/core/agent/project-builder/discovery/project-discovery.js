const {
  detectManifest
} = require('./project-manifest');

class ProjectDiscovery {
  constructor({ workspace }) {
    if (!workspace) {
      throw new TypeError(
        'workspace is required'
      );
    }

    this.workspace = workspace;
  }

  async discover() {
    const entries =
      await this.workspace.list('.');

    const names =
      entries.map(
        entry => entry.name
      );

    const manifest =
      detectManifest(names);

    const instructions = [];

    if (names.includes('AGENT.md')) {
      instructions.push('AGENT.md');
    }

    const files =
      entries
        .filter(
          entry => entry.isFile()
        )
        .map(
          entry => entry.name
        )
        .sort();

    const gitEntry =
      entries.find(
        entry => entry.name === '.git'
      );

    return {
      projectRoot:
        this.workspace.policy.assertRead('.'),

      manifest,

      detectedStack:
        manifest.stack,

      files,

      instructions,

      git: {
        detected:
          Boolean(gitEntry),

        type:
          gitEntry
            ? (
                gitEntry.isDirectory()
                  ? 'directory'
                  : 'file'
              )
            : null
      }
    };
  }
}

module.exports = ProjectDiscovery;
