const test = require('node:test');
const assert =
  require('node:assert/strict');

const fs =
  require('node:fs/promises');
const fsSync = require('node:fs');

const os =
  require('node:os');

const path =
  require('node:path');

const PROJECT_MODIFIER_TEST_FILES = [
  'tmp/project-modifier-create.txt',
  'tmp/project-modifier-update.txt',
  'tmp/project-modifier-apply.txt',
  'tmp/project-modifier-batch-create.txt',
  'tmp/project-modifier-batch-update.txt'
];

test.after(async () => {
  await Promise.all(
    PROJECT_MODIFIER_TEST_FILES.map((file) =>
      fs.rm(file, { force: true })
    )
  );
});

const ProjectBuilderAgent =
  require('../../../../../src/core/agent/project-builder/project-builder-agent');

const WorkspacePolicy =
  require('../../../../../src/core/agent/project-builder/workspace/workspace-policy');

const FileWorkspace =
  require('../../../../../src/core/agent/project-builder/workspace/file-workspace');

const CommandRunner =
  require('../../../../../src/core/agent/project-builder/workspace/command-runner');

test(
  'builder requires a project root',
  () => {
    assert.throws(
      () => new ProjectBuilderAgent(),
      /projectRoot is required/
    );
  }
);

test(
  'audit discovers manifests, AGENT.md and git without modifying the project',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-builder-'
        )
      );

    await fs.writeFile(
      path.join(root, 'AGENT.md'),
      '# Constitution'
    );

    await fs.writeFile(
      path.join(root, 'package.json'),
      '{}'
    );

    await fs.mkdir(
      path.join(root, '.git')
    );

    await fs.writeFile(
      path.join(root, 'README.md'),
      'readme'
    );

    const agent =
      new ProjectBuilderAgent({
        projectRoot: root
      });

    const result =
      await agent.audit();

    assert.equal(
      result.projectRoot,
      root
    );

    assert.deepEqual(
      result.manifest.files,
      ['package.json']
    );

    assert.deepEqual(
      result.detectedStack,
      ['node']
    );

    assert.deepEqual(
      result.instructions,
      ['AGENT.md']
    );

    assert.equal(
      result.agentInstructions,
      '# Constitution'
    );

    assert.equal(
      result.git.detected,
      true
    );

    assert.equal(
      result.audit.modificationAllowed,
      false
    );

    assert.equal(
      result.audit.commandExecutionAllowed,
      false
    );

    assert.equal(
      await fs.readFile(
        path.join(root, 'AGENT.md'),
        'utf8'
      ),
      '# Constitution'
    );

    await fs.rm(
      root,
      {
        recursive: true,
        force: true
      }
    );
  }
);

test(
  'workspace policy prevents path escape and writes by default',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-policy-'
        )
      );

    const policy =
      new WorkspacePolicy({
        allowedRoot: root
      });

    const workspace =
      new FileWorkspace({
        policy
      });

    assert.equal(
      policy.resolve('.'),
      root
    );

    assert.throws(
      () =>
        policy.resolve(
          '../outside'
        ),
      /escapes allowed root/
    );

    await assert.rejects(
      () =>
        workspace.writeText(
          'new.txt',
          'x'
        ),
      /write access is denied/
    );

    await fs.rm(
      root,
      {
        recursive: true,
        force: true
      }
    );
  }
);

test(
  'command runner is denied unless explicitly enabled',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-command-'
        )
      );

    const policy =
      new WorkspacePolicy({
        allowedRoot: root
      });

    const runner =
      new CommandRunner({
        policy
      });

    assert.throws(
      () =>
        runner.run(
          'node',
          {
            args: [
              '-e',
              'process.stdout.write("ok")'
            ]
          }
        ),
      /command execution is denied/
    );

    await fs.rm(
      root,
      {
        recursive: true,
        force: true
      }
    );
  }
);

test('audit engine reports missing project manifest as a gap', async () => {
  const projectRoot = fsSync.mkdtempSync(
    path.join(os.tmpdir(), 'orient-builder-audit-')
  );

  fsSync.mkdirSync(path.join(projectRoot, 'src'));
  fsSync.mkdirSync(path.join(projectRoot, 'test'));
  fsSync.mkdirSync(path.join(projectRoot, '.git'));
  fsSync.writeFileSync(
    path.join(projectRoot, 'AGENT.md'),
    '# Test Project'
  );

  const builder = new ProjectBuilderAgent({
    projectRoot
  });

  const result = await builder.auditor.audit();

  assert.equal(result.status, 'needs-work');
  assert.equal(result.projectType, 'unknown');

  assert.ok(
    result.gaps.some(
      gap => gap.id === 'missing-project-manifest'
    )
  );

  assert.equal(
    result.definitionOfDone.satisfied,
    false
  );
});

test('build plan generator creates ordered execution phases from audit', () => {
  const BuildPlanGenerator =
    require('../../../../../src/core/agent/project-builder/planning/build-plan-generator');

  const generator =
    new BuildPlanGenerator();

  const plan =
    generator.generate({
      goal: 'Complete the project',
      audit: {
        gaps: [
          {
            id: 'missing-project-manifest',
            severity: 'warning'
          }
        ],
        definitionOfDone: {
          required: [
            'Tests pass',
            'Verification succeeds'
          ],
          satisfied: false
        }
      }
    });

  assert.equal(
    plan.goal,
    'Complete the project'
  );

  assert.deepEqual(
    plan.phases.map(phase => phase.id),
    [
      'understand',
      'resolve-gaps',
      'implement',
      'verify'
    ]
  );

  assert.equal(
    plan.phases[1].gaps.length,
    1
  );

  assert.equal(
    plan.phases[3].status,
    'pending'
  );

  assert.equal(
    plan.definitionOfDone.satisfied,
    false
  );

  assert.ok(
    plan.constraints.length > 0
  );
});

test('builder generates a plan from its audit without modifying the workspace', async () => {
  const projectRoot = fsSync.mkdtempSync(
    path.join(os.tmpdir(), 'orient-builder-plan-')
  );

  fsSync.mkdirSync(
    path.join(projectRoot, 'src')
  );

  fsSync.mkdirSync(
    path.join(projectRoot, 'test')
  );

  fsSync.writeFileSync(
    path.join(projectRoot, 'AGENT.md'),
    '# Constitution'
  );

  const builder =
    new ProjectBuilderAgent({
      projectRoot
    });

  const plan =
    await builder.plan({
      goal: 'Complete this project'
    });

  assert.equal(
    plan.goal,
    'Complete this project'
  );

  assert.deepEqual(
    plan.phases.map(
      phase => phase.id
    ),
    [
      'understand',
      'resolve-gaps',
      'implement',
      'verify'
    ]
  );

  assert.equal(
    plan.definitionOfDone.satisfied,
    false
  );

  assert.ok(
    plan.phases[1].gaps.some(
      gap =>
        gap.id ===
        'missing-project-manifest'
    )
  );
});

test('verification engine passes only when all checks pass', async () => {
  const ProjectVerifier =
    require('../../../../../src/core/agent/project-builder/verification/project-verifier');

  const verifier =
    new ProjectVerifier({
      workspace: {}
    });

  const result =
    await verifier.verify({
      definitionOfDone: {
        required: [
          'tests pass',
          'build succeeds'
        ]
      },
      checks: [
        {
          id: 'tests',
          run: async () => true
        },
        {
          id: 'build',
          run: async () => true
        }
      ]
    });

  assert.equal(
    result.status,
    'passed'
  );

  assert.equal(
    result.passed,
    2
  );

  assert.equal(
    result.failed,
    0
  );

  assert.equal(
    result.definitionOfDoneSatisfied,
    true
  );
});

test('verification engine fails when a check fails', async () => {
  const ProjectVerifier =
    require('../../../../../src/core/agent/project-builder/verification/project-verifier');

  const verifier =
    new ProjectVerifier({
      workspace: {}
    });

  const result =
    await verifier.verify({
      definitionOfDone: {
        required: [
          'tests pass',
          'build succeeds'
        ]
      },
      checks: [
        {
          id: 'tests',
          run: async () => true
        },
        {
          id: 'build',
          run: async () => false
        }
      ]
    });

  assert.equal(
    result.status,
    'failed'
  );

  assert.equal(
    result.passed,
    1
  );

  assert.equal(
    result.failed,
    1
  );

  assert.equal(
    result.definitionOfDoneSatisfied,
    false
  );
});

test('verification engine records thrown check errors as failures', async () => {
  const ProjectVerifier =
    require('../../../../../src/core/agent/project-builder/verification/project-verifier');

  const verifier =
    new ProjectVerifier({
      workspace: {}
    });

  const result =
    await verifier.verify({
      definitionOfDone: {
        required: [
          'tests pass'
        ]
      },
      checks: [
        {
          id: 'tests',
          run: async () => {
            throw new Error('tests crashed');
          }
        }
      ]
    });

  assert.equal(
    result.status,
    'failed'
  );

  assert.equal(
    result.failed,
    1
  );

  assert.equal(
    result.checks[0].error,
    'tests crashed'
  );
});

test('command verification passes for an allowed successful command', async () => {
  const CommandRunner =
    require('../../../../../src/core/agent/project-builder/workspace/command-runner');

  const CommandVerification =
    require('../../../../../src/core/agent/project-builder/verification/command-verification');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowCommands: true,
      allowedCommands: ['node'],
      deniedCommands: ['rm']
    });

  const workspace =
    new FileWorkspace({
      policy
    });

  const runner =
    new CommandRunner({
      policy
    });

  const verification =
    new CommandVerification({
      commandRunner: runner
    });

  const check =
    verification.createCheck({
      id: 'node-version',
      executable: process.execPath,
      args: ['--version']
    });

  const result =
    await check.run();

  assert.equal(
    result.passed,
    true
  );

  assert.equal(
    result.exitCode,
    0
  );
});

test('command verification fails for a command with non-zero exit code', async () => {
  const CommandRunner =
    require('../../../../../src/core/agent/project-builder/workspace/command-runner');

  const CommandVerification =
    require('../../../../../src/core/agent/project-builder/verification/command-verification');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowCommands: true,
      allowedCommands: ['node']
    });

  const workspace =
    new FileWorkspace({
      policy
    });

  const runner =
    new CommandRunner({
      policy
    });

  const verification =
    new CommandVerification({
      commandRunner: runner
    });

  const check =
    verification.createCheck({
      id: 'expected-failure',
      executable: process.execPath,
      args: [
        '-e',
        'process.exit(1)'
      ]
    });

  const result =
    await check.run();

  assert.equal(
    result.passed,
    false
  );

  assert.equal(
    result.exitCode,
    1
  );
});
test('project verifier treats a failed command verification as a failed check', async () => {
  const CommandRunner =
    require('../../../../../src/core/agent/project-builder/workspace/command-runner');

  const CommandVerification =
    require('../../../../../src/core/agent/project-builder/verification/command-verification');

  const ProjectVerifier =
    require('../../../../../src/core/agent/project-builder/verification/project-verifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowCommands: true,
      allowedCommands: ['node']
    });

  const runner =
    new CommandRunner({
      policy
    });

  const commandVerification =
    new CommandVerification({
      commandRunner: runner
    });

  const verifier =
    new ProjectVerifier({
      workspace: new FileWorkspace({
        policy
      })
    });

  const check =
    commandVerification.createCheck({
      id: 'expected-failure',
      executable: process.execPath,
      args: [
        '-e',
        'process.exit(1)'
      ]
    });

  const result =
    await verifier.verify({
      definitionOfDone: [
        'verification passes'
      ],
      checks: [
        check
      ]
    });

  assert.equal(
    result.status,
    'failed'
  );

  assert.equal(
    result.passed,
    0
  );

  assert.equal(
    result.failed,
    1
  );

  assert.equal(
    result.checks[0].passed,
    false
  );

  assert.equal(
    result.checks[0].result.exitCode,
    1
  );

  assert.equal(
    result.definitionOfDoneSatisfied,
    false
  );
});

test('project modifier creates a file inside the allowed workspace', async () => {
  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowWrite: true
    });

  const workspace =
    new FileWorkspace({
      policy
    });

  const modifier =
    new ProjectModifier({
      workspace
    });

  const filePath =
    'tmp/project-modifier-create.txt';

  const result =
    await modifier.createFile({
      path: filePath,
      content: 'ORIENT ONE'
    });

  assert.equal(
    result.action,
    'create'
  );

  assert.equal(
    result.path,
    filePath
  );

  assert.equal(
    await workspace.readText(filePath),
    'ORIENT ONE'
  );
});

test('project modifier updates an existing file', async () => {
  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowWrite: true
    });

  const workspace =
    new FileWorkspace({
      policy
    });

  const modifier =
    new ProjectModifier({
      workspace
    });

  const filePath =
    'tmp/project-modifier-update.txt';

  await workspace.writeText(
    filePath,
    'before'
  );

  const result =
    await modifier.updateFile({
      path: filePath,
      content: 'after'
    });

  assert.equal(
    result.action,
    'update'
  );

  assert.equal(
    await workspace.readText(filePath),
    'after'
  );
});

test('project modifier cannot write when workspace writes are disabled', async () => {
  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd()
    });

  const workspace =
    new FileWorkspace({
      policy
    });

  const modifier =
    new ProjectModifier({
      workspace
    });

  await assert.rejects(
    () =>
      modifier.createFile({
        path: 'tmp/blocked.txt',
        content: 'blocked'
      }),
    /Workspace write access is denied/
  );
});

test('project modifier cannot escape the allowed workspace', async () => {
  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowWrite: true
    });

  const workspace =
    new FileWorkspace({
      policy
    });

  const modifier =
    new ProjectModifier({
      workspace
    });

  await assert.rejects(
    () =>
      modifier.createFile({
        path: '../outside.txt',
        content: 'blocked'
      }),
    /Workspace path escapes allowed root/
  );
});

test('change set accepts valid create and update changes', () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  const changeSet =
    new ChangeSet({
      changes: [
        {
          action: 'create',
          path: 'src/new-file.js',
          content: 'module.exports = true;'
        },
        {
          action: 'update',
          path: 'src/app.js',
          content: 'updated'
        }
      ]
    });

  assert.equal(
    changeSet.changes.length,
    2
  );

  assert.deepEqual(
    changeSet.changes[0],
    {
      action: 'create',
      path: 'src/new-file.js',
      content: 'module.exports = true;'
    }
  );

  assert.deepEqual(
    changeSet.changes[1],
    {
      action: 'update',
      path: 'src/app.js',
      content: 'updated'
    }
  );
});

test('change set rejects invalid actions', () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  assert.throws(
    () =>
      new ChangeSet({
        changes: [
          {
            action: 'delete',
            path: 'src/app.js',
            content: ''
          }
        ]
      }),
    /Change action must be create or update/
  );
});

test('change set rejects missing paths', () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  assert.throws(
    () =>
      new ChangeSet({
        changes: [
          {
            action: 'create',
            content: 'test'
          }
        ]
      }),
    /Change path is required/
  );
});

test('change set rejects non-string content', () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  assert.throws(
    () =>
      new ChangeSet({
        changes: [
          {
            action: 'create',
            path: 'src/test.js',
            content: 123
          }
        ]
      }),
    /Change content must be a string/
  );
});

test('change set can add a validated change', () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  const changeSet =
    new ChangeSet();

  changeSet.add({
    action: 'create',
    path: 'src/example.js',
    content: 'example'
  });

  assert.equal(
    changeSet.changes.length,
    1
  );

  assert.equal(
    changeSet.changes[0].action,
    'create'
  );
});

test('change set serializes its changes', () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  const changeSet =
    new ChangeSet({
      changes: [
        {
          action: 'create',
          path: 'src/example.js',
          content: 'example'
        }
      ]
    });

  assert.deepEqual(
    changeSet.toJSON(),
    {
      changes: [
        {
          action: 'create',
          path: 'src/example.js',
          content: 'example'
        }
      ]
    }
  );
});


test('project modifier applies a valid change set', async () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowWrite: true
    });

  const workspace =
    new FileWorkspace({ policy });

  const modifier =
    new ProjectModifier({ workspace });

  const filePath =
    'tmp/project-modifier-apply.txt';

  const changeSet =
    new ChangeSet({
      changes: [
        {
          action: 'create',
          path: filePath,
          content: 'created'
        }
      ]
    });

  const result =
    await modifier.apply(changeSet);

  assert.equal(result.applied, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].action, 'create');
  assert.equal(
    await workspace.readText(filePath),
    'created'
  );
});

test('project modifier validates all changes before writing any file', async () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowWrite: true
    });

  const workspace =
    new FileWorkspace({ policy });

  const modifier =
    new ProjectModifier({ workspace });

  const firstFile =
    'tmp/project-modifier-atomic-first.txt';

  const missingFile =
    'tmp/project-modifier-atomic-missing.txt';

  const changeSet =
    new ChangeSet({
      changes: [
        {
          action: 'create',
          path: firstFile,
          content: 'must not be written'
        },
        {
          action: 'update',
          path: missingFile,
          content: 'invalid'
        }
      ]
    });

  await assert.rejects(
    () => modifier.apply(changeSet),
    /File does not exist/
  );

  assert.equal(
    await workspace.exists(firstFile),
    false
  );
});

test('project modifier applies create and update changes together', async () => {
  const ChangeSet =
    require('../../../../../src/core/agent/project-builder/modification/change-set');

  const ProjectModifier =
    require('../../../../../src/core/agent/project-builder/modification/project-modifier');

  const policy =
    new WorkspacePolicy({
      allowedRoot: process.cwd(),
      allowWrite: true
    });

  const workspace =
    new FileWorkspace({ policy });

  const modifier =
    new ProjectModifier({ workspace });

  const createdFile =
    'tmp/project-modifier-batch-create.txt';

  const updatedFile =
    'tmp/project-modifier-batch-update.txt';

  await workspace.writeText(
    updatedFile,
    'before'
  );

  const changeSet =
    new ChangeSet({
      changes: [
        {
          action: 'create',
          path: createdFile,
          content: 'new'
        },
        {
          action: 'update',
          path: updatedFile,
          content: 'after'
        }
      ]
    });

  const result =
    await modifier.apply(changeSet);

  assert.equal(result.applied, true);

  assert.equal(
    await workspace.readText(createdFile),
    'new'
  );

  assert.equal(
    await workspace.readText(updatedFile),
    'after'
  );
});

const BuildExecutionResult =
  require('../../../../../src/core/agent/project-builder/execution/build-execution-result');

test(
  'build execution result accepts a valid status',
  () => {
    const result =
      new BuildExecutionResult({
        status: 'verified'
      });

    assert.equal(result.status, 'verified');
  }
);

test(
  'build execution result rejects an invalid status',
  () => {
    assert.throws(
      () =>
        new BuildExecutionResult({
          status: 'completed'
        }),
      /Invalid execution status/
    );
  }
);

test(
  'build execution result preserves execution evidence',
  () => {
    const result =
      new BuildExecutionResult({
        status: 'modified',
        plan: { phases: ['implement'] },
        changeSet: { changes: [] },
        modification: { applied: true }
      });

    assert.deepEqual(
      result.toJSON(),
      {
        status: 'modified',
        plan: { phases: ['implement'] },
        changeSet: { changes: [] },
        modification: { applied: true },
        verification: null,
        error: null
      }
    );
  }
);

const BuildExecutionService =
  require('../../../../../src/core/agent/project-builder/execution/build-execution-service');

test(
  'build execution service requires a modifier',
  () => {
    assert.throws(
      () =>
        new BuildExecutionService({
          verifier: {}
        }),
      /modifier is required/
    );
  }
);

test(
  'build execution service requires a verifier',
  () => {
    assert.throws(
      () =>
        new BuildExecutionService({
          modifier: {}
        }),
      /verifier is required/
    );
  }
);

test(
  'build execution service requires a change set',
  async () => {
    const service =
      new BuildExecutionService({
        modifier: {},
        verifier: {}
      });

    await assert.rejects(
      () => service.execute(),
      /changeSet with changes is required/
    );
  }
);

test(
  'build execution service modifies and verifies successfully',
  async () => {
    const modifier = {
      apply: async (changeSet) => ({
        applied: true,
        changes: changeSet.changes
      })
    };

    const verifier = {
      verify: async () => ({
        status: 'passed',
        passed: true,
        failed: 0
      })
    };

    const service =
      new BuildExecutionService({
        modifier,
        verifier
      });

    const changeSet = {
      changes: [
        {
          action: 'create',
          path: 'tmp/execution-service.txt',
          content: 'ok'
        }
      ]
    };

    const result =
      await service.execute({
        plan: { phases: ['implement'] },
        changeSet,
        definitionOfDone: {
          required: ['verification']
        }
      });

    assert.equal(result.status, 'verified');
    assert.equal(result.modification.applied, true);
    assert.equal(result.verification.passed, true);
  }
);

test(
  'build execution service reports verification failure',
  async () => {
    const modifier = {
      apply: async () => ({
        applied: true,
        changes: []
      })
    };

    const verifier = {
      verify: async () => ({
        status: 'failed',
        passed: false,
        failed: 1
      })
    };

    const service =
      new BuildExecutionService({
        modifier,
        verifier
      });

    const result =
      await service.execute({
        changeSet: {
          changes: []
        },
        definitionOfDone: {
          required: ['verification']
        }
      });

    assert.equal(result.status, 'failed');
    assert.equal(result.verification.passed, false);
  }
);

test(
  'build execution service captures modification errors',
  async () => {
    const modifier = {
      apply: async () => {
        throw new Error('modification failed');
      }
    };

    const verifier = {
      verify: async () => ({
        passed: true
      })
    };

    const service =
      new BuildExecutionService({
        modifier,
        verifier
      });

    const result =
      await service.execute({
        changeSet: {
          changes: []
        }
      });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.message, 'modification failed');
  }
);

test(
  'project modifier rolls back a previous change when a later write fails',
  async () => {
    let writes = 0;

    const workspace = {
      exists: async (path) =>
        path === 'tmp/second.txt',

      readText: async () =>
        'original',

      writeText: async () => {
        writes += 1;

        if (writes === 2) {
          throw new Error('write failed');
        }
      },

      removeFile: async () => {}
    };

    const ProjectModifier =
      require('../../../../../src/core/agent/project-builder/modification/project-modifier');

    const modifier =
      new ProjectModifier({ workspace });

    await assert.rejects(
      () =>
        modifier.apply({
          changes: [
            {
              action: 'create',
              path: 'tmp/first.txt',
              content: '1'
            },
            {
              action: 'update',
              path: 'tmp/second.txt',
              content: '2'
            }
          ]
        }),
      /write failed/
    );

    assert.equal(writes, 3);
  }
);

test(
  'file workspace removes a file inside the allowed workspace',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-one-remove-'
        )
      );

    const policy =
      new WorkspacePolicy({
        allowedRoot: root,
        allowWrite: true
      });

    const workspace =
      new FileWorkspace({ policy });

    await workspace.writeText(
      'remove-me.txt',
      'temporary'
    );

    assert.equal(
      await workspace.exists('remove-me.txt'),
      true
    );

    await workspace.removeFile(
      'remove-me.txt'
    );

    assert.equal(
      await workspace.exists('remove-me.txt'),
      false
    );

    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
);

test(
  'file workspace removeFile respects write access policy',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-one-remove-denied-'
        )
      );

    const policy =
      new WorkspacePolicy({
        allowedRoot: root,
        allowWrite: false
      });

    const workspace =
      new FileWorkspace({ policy });

    await assert.rejects(
      () =>
        workspace.removeFile(
          'remove-me.txt'
        ),
      /Workspace write access is denied/
    );

    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
);

test(
  'project modifier rolls back a newly created file after a later failure',
  async () => {
    const files = new Map();

    const workspace = {
      exists: async (filePath) =>
        files.has(filePath),

      readText: async (filePath) =>
        files.get(filePath),

      writeText: async (filePath, content) => {
        if (filePath === 'tmp/fail.txt') {
          throw new Error('write failed');
        }

        files.set(filePath, content);
      },

      removeFile: async (filePath) => {
        files.delete(filePath);
      }
    };

    const ProjectModifier =
      require('../../../../../src/core/agent/project-builder/modification/project-modifier');

    const modifier =
      new ProjectModifier({ workspace });

    await assert.rejects(
      () =>
        modifier.apply({
          changes: [
            {
              action: 'create',
              path: 'tmp/new.txt',
              content: 'new'
            },
            {
              action: 'create',
              path: 'tmp/fail.txt',
              content: 'fail'
            }
          ]
        }),
      /write failed/
    );

    assert.equal(
      files.has('tmp/new.txt'),
      false
    );

    assert.equal(
      files.has('tmp/fail.txt'),
      false
    );
  }
);

test(
  'project modifier restores original content after a later failure',
  async () => {
    const files = new Map([
      ['tmp/existing.txt', 'original']
    ]);

    const workspace = {
      exists: async (filePath) =>
        files.has(filePath),

      readText: async (filePath) =>
        files.get(filePath),

      writeText: async (filePath, content) => {
        if (filePath === 'tmp/fail.txt') {
          throw new Error('write failed');
        }

        files.set(filePath, content);
      },

      removeFile: async (filePath) => {
        files.delete(filePath);
      }
    };

    const ProjectModifier =
      require('../../../../../src/core/agent/project-builder/modification/project-modifier');

    const modifier =
      new ProjectModifier({ workspace });

    await assert.rejects(
      () =>
        modifier.apply({
          changes: [
            {
              action: 'update',
              path: 'tmp/existing.txt',
              content: 'changed'
            },
            {
              action: 'create',
              path: 'tmp/fail.txt',
              content: 'fail'
            }
          ]
        }),
      /write failed/
    );

    assert.equal(
      files.get('tmp/existing.txt'),
      'original'
    );

    assert.equal(
      files.has('tmp/fail.txt'),
      false
    );
  }
);

test(
  'change set rejects duplicate paths',
  () => {
    const ChangeSet =
      require('../../../../../src/core/agent/project-builder/modification/change-set');

    assert.throws(
      () =>
        new ChangeSet({
          changes: [
            {
              action: 'create',
              path: 'tmp/same.txt',
              content: 'one'
            },
            {
              action: 'update',
              path: 'tmp/same.txt',
              content: 'two'
            }
          ]
        }),
      /Duplicate change path/
    );
  }
);

test(
  'project modifier reports rollback failure without losing the original error',
  async () => {
    const files = new Map([
      ['tmp/existing.txt', 'original']
    ]);

    let updateAttempts = 0;

    const workspace = {
      exists: async filePath =>
        files.has(filePath),

      readText: async filePath =>
        files.get(filePath),

      writeText: async (filePath, content) => {
        updateAttempts += 1;

        if (filePath === 'tmp/fail.txt') {
          throw new Error('original write failed');
        }

        if (
          filePath === 'tmp/existing.txt' &&
          updateAttempts > 1
        ) {
          throw new Error('rollback write failed');
        }

        files.set(filePath, content);
      },

      removeFile: async filePath => {
        files.delete(filePath);
      }
    };

    const ProjectModifier =
      require('../../../../../src/core/agent/project-builder/modification/project-modifier');

    const modifier =
      new ProjectModifier({ workspace });

    await assert.rejects(
      () =>
        modifier.apply({
          changes: [
            {
              action: 'update',
              path: 'tmp/existing.txt',
              content: 'changed'
            },
            {
              action: 'create',
              path: 'tmp/fail.txt',
              content: 'fail'
            }
          ]
        }),
      error => {
        assert.match(
          error.message,
          /Modification failed and rollback failed/
        );

        assert.equal(
          error.cause?.message,
          'original write failed'
        );

        assert.equal(
          error.rollbackError?.message,
          'Rollback failed'
        );

        return true;
      }
    );
  }
);

test(
  'project builder agent executes a change set and verifies it',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-one-builder-execute-'
        )
      );

    const ProjectBuilderAgent =
      require('../../../../../src/core/agent/project-builder/project-builder-agent');

    const agent =
      new ProjectBuilderAgent({
        projectRoot: root,
        policy: {
          allowWrite: true
        }
      });

    const result =
      await agent.execute({
        plan: {
          goal: 'create builder test file'
        },
        changeSet: {
          changes: [
            {
              action: 'create',
              path: 'result.txt',
              content: 'ORIENT ONE'
            }
          ]
        },
        definitionOfDone: [
          'change applied',
          'verification passed'
        ],
        checks: [
          {
            id: 'file-created',
            run: async ({ workspace }) => {
              const exists =
                await workspace.exists(
                  'result.txt'
                );

              return {
                passed: exists
              };
            }
          }
        ]
      });

    assert.equal(
      result.status,
      'verified'
    );

    assert.equal(
      result.verification.passed,
      1
    );

    assert.equal(
      await fs.readFile(
        path.join(root, 'result.txt'),
        'utf8'
      ),
      'ORIENT ONE'
    );

    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
);

test(
  'project builder agent reports failed verification',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-one-builder-fail-'
        )
      );

    const ProjectBuilderAgent =
      require('../../../../../src/core/agent/project-builder/project-builder-agent');

    const agent =
      new ProjectBuilderAgent({
        projectRoot: root,
        policy: {
          allowWrite: true
        }
      });

    const result =
      await agent.execute({
        changeSet: {
          changes: [
            {
              action: 'create',
              path: 'result.txt',
              content: 'ORIENT ONE'
            }
          ]
        },
        definitionOfDone: [
          'verification must pass'
        ],
        checks: [
          {
            id: 'forced-failure',
            run: async () => ({
              passed: false
            })
          }
        ]
      });

    assert.equal(
      result.status,
      'failed'
    );

    assert.equal(
      result.verification.passed,
      0
    );

    assert.equal(
      result.verification.failed,
      1
    );

    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
);

test(
  'implementation plan preserves implementation data',
  () => {
    const ImplementationPlan =
      require('../../../../../src/core/agent/project-builder/implementation/implementation-plan');

    const ChangeSet =
      require('../../../../../src/core/agent/project-builder/modification/change-set');

    const changeSet =
      new ChangeSet({
        changes: [
          {
            action: 'create',
            path: 'src/example.js',
            content: 'module.exports = true;'
          }
        ]
      });

    const plan =
      new ImplementationPlan({
        goal: 'implement feature',
        changeSet,
        assumptions: [
          'existing architecture is preserved'
        ],
        risks: [
          'verification may fail'
        ]
      });

    assert.equal(
      plan.goal,
      'implement feature'
    );

    assert.equal(
      plan.changeSet.changes.length,
      1
    );

    assert.equal(
      plan.assumptions.length,
      1
    );

    assert.equal(
      plan.risks.length,
      1
    );

    assert.deepEqual(
      plan.toJSON().changeSet,
      {
        changes: [
          {
            action: 'create',
            path: 'src/example.js',
            content: 'module.exports = true;'
          }
        ]
      }
    );
  }
);

test(
  'implementation plan rejects an invalid change set',
  () => {
    const ImplementationPlan =
      require('../../../../../src/core/agent/project-builder/implementation/implementation-plan');

    assert.throws(
      () =>
        new ImplementationPlan({
          changeSet: {}
        }),
      /changeSet must be a ChangeSet or null/
    );
  }
);

test(
  'implementation planner converts a build plan into an implementation plan',
  () => {
    const ImplementationPlanner =
      require('../../../../../src/core/agent/project-builder/implementation/implementation-planner');

    const planner =
      new ImplementationPlanner();

    const result =
      planner.generate({
        buildPlan: {
          goal: 'complete project',
          phases: [
            'understand',
            'implement',
            'verify'
          ]
        },
        changes: [
          {
            action: 'create',
            path: 'src/example.js',
            content: 'module.exports = true;'
          }
        ],
        assumptions: [
          'preserve existing architecture'
        ],
        risks: [
          'tests may fail'
        ]
      });

    assert.equal(
      result.goal,
      'complete project'
    );

    assert.equal(
      result.changeSet.changes.length,
      1
    );

    assert.deepEqual(
      result.changeSet.toJSON(),
      {
        changes: [
          {
            action: 'create',
            path: 'src/example.js',
            content: 'module.exports = true;'
          }
        ]
      }
    );
  }
);

test(
  'implementation planner rejects a missing build plan',
  () => {
    const ImplementationPlanner =
      require('../../../../../src/core/agent/project-builder/implementation/implementation-planner');

    const planner =
      new ImplementationPlanner();

    assert.throws(
      () =>
        planner.generate(),
      /buildPlan is required/
    );
  }
);


test(
  'implementation planner converts a build plan into an implementation plan',
  () => {
    const ImplementationPlanner =
      require('../../../../../src/core/agent/project-builder/implementation/implementation-planner');

    const planner =
      new ImplementationPlanner();

    const result =
      planner.generate({
        buildPlan: {
          goal: 'complete project',
          phases: [
            'understand',
            'implement',
            'verify'
          ]
        },
        changes: [
          {
            action: 'create',
            path: 'src/example.js',
            content: 'module.exports = true;'
          }
        ],
        assumptions: [
          'preserve existing architecture'
        ],
        risks: [
          'tests may fail'
        ]
      });

    assert.equal(
      result.goal,
      'complete project'
    );

    assert.deepEqual(
      result.changeSet.changes,
      [
        {
          action: 'create',
          path: 'src/example.js',
          content: 'module.exports = true;'
        }
      ]
    );

    assert.deepEqual(
      result.assumptions,
      [
        'preserve existing architecture'
      ]
    );

    assert.deepEqual(
      result.risks,
      [
        'tests may fail'
      ]
    );
  }
);

test(
  'implementation planner rejects a missing build plan',
  () => {
    const ImplementationPlanner =
      require('../../../../../src/core/agent/project-builder/implementation/implementation-planner');

    const planner =
      new ImplementationPlanner();

    assert.throws(
      () =>
        planner.generate(),
      /buildPlan is required/
    );
  }
);

test(
  'project builder agent creates an implementation plan',
  async () => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'orient-one-builder-implement-'
        )
      );

    const ProjectBuilderAgent =
      require('../../../../../src/core/agent/project-builder/project-builder-agent');

    const agent =
      new ProjectBuilderAgent({
        projectRoot: root
      });

    const result =
      await agent.implement({
        buildPlan: {
          goal: 'complete project',
          phases: [
            'understand',
            'implement',
            'verify'
          ]
        },
        changes: [
          {
            action: 'create',
            path: 'src/example.js',
            content: 'module.exports = true;'
          }
        ]
      });

    assert.equal(
      result.goal,
      'complete project'
    );

    assert.equal(
      result.changeSet.changes.length,
      1
    );

    assert.deepEqual(
      result.changeSet.changes[0],
      {
        action: 'create',
        path: 'src/example.js',
        content: 'module.exports = true;'
      }
    );

    await fs.rm(root, {
      recursive: true,
      force: true
    });
  }
);

test('workspace policy allows an explicitly allowlisted command', () => {
  const policy = new WorkspacePolicy({
    allowedRoot: process.cwd(),
    allowCommands: true,
    allowedCommands: ['node']
  });

  assert.equal(
    policy.assertCommand(process.execPath),
    process.execPath
  );
});

test('workspace policy denies a command that is not allowlisted', () => {
  const policy = new WorkspacePolicy({
    allowedRoot: process.cwd(),
    allowCommands: true,
    allowedCommands: ['node']
  });

  assert.throws(
    () => policy.assertCommand('rm'),
    /not allowed/
  );
});

test('workspace policy requires an explicit command allowlist', () => {
  const policy = new WorkspacePolicy({
    allowedRoot: process.cwd(),
    allowCommands: true
  });

  assert.throws(
    () => policy.assertCommand('node'),
    /not allowed/
  );
});

test('project builder execution profile controls workspace command allowlist', async () => {
  const ProjectBuilderAgent =
    require('../../../../../src/core/agent/project-builder/project-builder-agent');

  const agent = new ProjectBuilderAgent({
    projectRoot: process.cwd(),
    policy: {
      allowCommands: true,
      executionProfile: {
        allowedCommands: ['node']
      }
    }
  });

  assert.equal(
    agent.policy.allowedCommands.has('node'),
    true
  );

  assert.equal(
    agent.policy.allowedCommands.has('rm'),
    false
  );

  assert.equal(
    agent.policy.assertCommand(process.execPath),
    process.execPath
  );

  assert.throws(
    () => agent.policy.assertCommand('rm'),
    /not allowed/
  );
});
