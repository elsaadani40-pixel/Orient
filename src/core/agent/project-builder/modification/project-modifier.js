const crypto = require('crypto');

class ProjectModifier {
  constructor({ workspace } = {}) {
    if (!workspace) {
      throw new TypeError('workspace is required');
    }

    this.workspace = workspace;
  }

  async validateChange(change) {
    if (!change || typeof change !== 'object') {
      throw new TypeError('Change must be an object');
    }

    const {
      action,
      path,
      content = ''
    } = change;

    if (action !== 'create' && action !== 'update') {
      throw new TypeError(
        'Change action must be create or update'
      );
    }

    if (
      typeof path !== 'string' ||
      !path
    ) {
      throw new TypeError(
        'Change path is required'
      );
    }

    if (typeof content !== 'string') {
      throw new TypeError(
        'Change content must be a string'
      );
    }

    const exists =
      await this.workspace.exists(path);

    if (action === 'update' && !exists) {
      throw new Error(
        `File does not exist: ${path}`
      );
    }

    if (action === 'update' && typeof change.expectedContentSha256 === 'string') {
      const current = await this.workspace.readText(path);
      const actualHash = crypto.createHash('sha256').update(current).digest('hex');
      if (actualHash !== change.expectedContentSha256) {
        const error = new Error(
          `Change precondition failed: ${path} was modified after the proposal was created`
        );
        error.code = 'CHANGE_PRECONDITION_FAILED';
        error.expectedContentSha256 = change.expectedContentSha256;
        error.actualContentSha256 = actualHash;
        throw error;
      }
    }

    if (action === 'create' && exists) {
      throw new Error(
        `File already exists: ${path}`
      );
    }

    return {
      action,
      path,
      content
    };
  }

  async createFile({
    path,
    content = ''
  }) {
    await this.workspace.writeText(
      path,
      content
    );

    return {
      action: 'create',
      path,
      content
    };
  }

  async updateFile({
    path,
    content
  }) {
    await this.workspace.writeText(
      path,
      content
    );

    return {
      action: 'update',
      path,
      content
    };
  }

  async snapshot(change) {
    const exists =
      await this.workspace.exists(
        change.path
      );

    if (!exists) {
      return {
        path: change.path,
        existed: false,
        content: null
      };
    }

    return {
      path: change.path,
      existed: true,
      content:
        await this.workspace.readText(
          change.path
        )
    };
  }

  async rollback(snapshots) {
    const rollbackErrors = [];

    for (
      let i = snapshots.length - 1;
      i >= 0;
      i -= 1
    ) {
      const snapshot = snapshots[i];

      try {
        if (snapshot.existed) {
          await this.workspace.writeText(
            snapshot.path,
            snapshot.content
          );
        } else {
          const exists =
            await this.workspace.exists(
              snapshot.path
            );

          if (exists) {
            await this.workspace.removeFile(
              snapshot.path
            );
          }
        }
      } catch (error) {
        rollbackErrors.push({
          path: snapshot.path,
          name: error.name,
          message: error.message
        });
      }
    }

    if (rollbackErrors.length > 0) {
      const error = new Error(
        'Rollback failed'
      );

      error.rollbackErrors =
        rollbackErrors;

      throw error;
    }

    return {
      rolledBack: true
    };
  }

  async apply(changeSet) {
    if (
      !changeSet ||
      !Array.isArray(changeSet.changes)
    ) {
      throw new TypeError(
        'changeSet with changes is required'
      );
    }

    const validatedChanges = [];

    for (
      const change of changeSet.changes
    ) {
      validatedChanges.push(
        await this.validateChange(change)
      );
    }

    const paths = new Set();

    for (
      const change of validatedChanges
    ) {
      if (paths.has(change.path)) {
        throw new Error(
          `Duplicate change path: ${change.path}`
        );
      }

      paths.add(change.path);
    }

    const snapshots = [];

    for (
      const change of validatedChanges
    ) {
      snapshots.push(
        await this.snapshot(change)
      );
    }

    const results = [];

    try {
      for (
        const change of validatedChanges
      ) {
        if (change.action === 'create') {
          results.push(
            await this.createFile(change)
          );
        } else {
          results.push(
            await this.updateFile(change)
          );
        }
      }

      return {
        applied: true,
        rolledBack: false,
        changes: results
      };
    } catch (error) {
      try {
        await this.rollback(snapshots);
      } catch (rollbackError) {
        const combinedError = new Error(
          `Modification failed and rollback failed: ${error.message}`
        );

        combinedError.cause = error;
        combinedError.rollbackError =
          rollbackError;

        throw combinedError;
      }

      throw error;
    }
  }
}

module.exports = ProjectModifier;
