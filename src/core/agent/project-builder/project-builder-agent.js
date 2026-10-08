const WorkspacePolicy =
  require('./workspace/workspace-policy');

const FileWorkspace =
  require('./workspace/file-workspace');

const ProjectDiscovery =
  require('./discovery/project-discovery');

const ProjectAuditor =
  require('./audit/project-auditor');

const BuildPlanGenerator =
  require('./planning/build-plan-generator');

const ProjectModifier =
  require('./modification/project-modifier');

const ProjectVerifier =
  require('./verification/project-verifier');

const BuildExecutionService =
  require('./execution/build-execution-service');

const BuildExecutionProfile =
  require('./execution/build-execution-profile');

const ImplementationPlanner =
  require('./implementation/implementation-planner');

const ChangeProposalGenerator =
  require('./change-proposal/change-proposal-generator');

const ProposalValidator =
  require('./change-proposal/proposal-validator');

const BuildPolicyGate =
  require('./policy/build-policy-gate');

class ProjectBuilderAgent {
  constructor({
    projectRoot,
    policy = {},
    workspace
  } = {}) {
    if (
      !projectRoot ||
      typeof projectRoot !== 'string'
    ) {
      throw new TypeError(
        'projectRoot is required'
      );
    }

    this.name =
      'ORIENT_PROJECT_BUILDER';

    this.version =
      '0.1.0';

    this.executionProfile =
      new BuildExecutionProfile(
        policy.executionProfile || {}
      );

    this.policy =
      workspace?.policy ||
      new WorkspacePolicy({
        allowedRoot: projectRoot,
        allowRead:
          policy.allowRead ??
          this.executionProfile.allowRead,
        allowWrite:
          policy.allowWrite ??
          this.executionProfile.allowWrite,
        allowCommands:
          policy.allowCommands ??
          this.executionProfile.allowCommands,
        allowGit:
          policy.allowGit ??
          this.executionProfile.allowGit,
        deniedCommands:
          policy.deniedCommands ?? [],
        allowedCommands:
          policy.allowedCommands ??
          this.executionProfile.allowedCommands,
        maxOutput:
          policy.maxOutput ?? 20000,
        timeoutMs:
          policy.timeoutMs ??
          this.executionProfile.timeoutMs
      });

    this.workspace =
      workspace ||
      new FileWorkspace({
        policy: this.policy
      });

    this.discovery =
      new ProjectDiscovery({
        workspace: this.workspace
      });

    this.auditor =
      new ProjectAuditor({
        workspace: this.workspace,
        discovery: this.discovery
      });

    this.planGenerator =
      new BuildPlanGenerator();

    this.modifier =
      new ProjectModifier({
        workspace: this.workspace
      });

    this.verifier =
      new ProjectVerifier({
        workspace: this.workspace
      });

    this.executionService =
      new BuildExecutionService({
        modifier: this.modifier,
        verifier: this.verifier
      });

    this.implementationPlanner =
      new ImplementationPlanner();

    this.changeProposalGenerator =
      new ChangeProposalGenerator();

    this.proposalValidator =
      new ProposalValidator({
        workspace: this.workspace
      });

    this.policyGate =
      new BuildPolicyGate({
        policy: this.policy
      });
  }

  async discover() {
    return this.discovery.discover();
  }

  async plan({ goal } = {}) {
    const audit = await this.auditor.audit();

    return this.planGenerator.generate({
      audit,
      goal
    });
  }

  async proposeChanges({
    buildPlan,
    proposals = []
  } = {}) {
    return this.changeProposalGenerator.generate({
      buildPlan,
      proposals
    });
  }

  evaluatePolicy({
    proposals = []
  } = {}) {
    return this.policyGate.evaluate({
      proposals
    });
  }

  async validateProposals({
    proposals = []
  } = {}) {
    return this.proposalValidator.validate({
      proposals
    });
  }

  async implement({
    buildPlan,
    changes = [],
    assumptions = [],
    risks = []
  } = {}) {
    return this.implementationPlanner.generate({
      buildPlan,
      changes,
      assumptions,
      risks
    });
  }

  async execute({
    plan = null,
    changeSet,
    definitionOfDone,
    checks = []
  } = {}) {
    if (
      !changeSet ||
      !Array.isArray(changeSet.changes)
    ) {
      throw new TypeError(
        'changeSet with changes is required'
      );
    }

    const policyDecision =
      this.policyGate.evaluate({
        proposals: changeSet.changes
      });

    if (!policyDecision.allowed) {
      return {
        status: 'blocked',
        policy: policyDecision,
        plan,
        changeSet
      };
    }

    const validation =
      await this.proposalValidator.validate({
        proposals: changeSet.changes
      });

    if (!validation.valid) {
      const preconditionFailure =
        validation.errors.find(
          error => error.code === 'CHANGE_PRECONDITION_FAILED'
        );

      if (preconditionFailure) {
        return {
          status: 'failed',
          plan,
          changeSet,
          error: preconditionFailure
        };
      }

      return {
        status: 'blocked',
        policy: {
          allowed: false,
          errors: validation.errors.map(error => ({
            ...error,
            code: 'INVALID_PROPOSAL'
          }))
        },
        plan,
        changeSet
      };
    }

    return this.executionService.execute({
      plan,
      changeSet,
      definitionOfDone,
      checks
    });
  }

  async audit() {
    const discovered =
      await this.discovery.discover();

    let agentInstructions = null;

    if (
      discovered.instructions.includes(
        'AGENT.md'
      )
    ) {
      agentInstructions =
        await this.workspace.readText(
          'AGENT.md'
        );
    }

    const result =
      await this.auditor.audit();

    return {
      ...discovered,
      ...result,
      projectRoot:
        discovered.projectRoot,
      agentInstructions,
      audit: {
        validWorkspace: true,
        manifestDetected:
          discovered.manifest.files.length > 0,
        instructionFileDetected:
          Boolean(agentInstructions),
        gitDetected:
          discovered.git.detected,
        modificationAllowed:
          this.policy.allowWrite,
        commandExecutionAllowed:
          this.policy.allowCommands
      }
    };
  }
}

module.exports =
  ProjectBuilderAgent;
