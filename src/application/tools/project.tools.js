const ToolInterface = require('../../core/tools/tool.interface');
const ProjectBuilderAgent = require('../../core/agent/project-builder/project-builder-agent');
const ProjectImprovementAnalyzer = require('../../core/agent/project-builder/change-proposal/project-improvement-analyzer');
const CommandRunner = require('../../core/agent/project-builder/workspace/command-runner');
const CommandVerification = require('../../core/agent/project-builder/verification/command-verification');

function createProjectTools({ projectRoot, policy = {} } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') throw new TypeError('projectRoot is required');
  const readOnlyPolicy = { ...policy, allowRead: true, allowWrite: false, allowCommands: false, allowGit: false };
  const audit = new ToolInterface({
    name: 'project.audit', description: 'فحص مشروع محلي قراءة فقط واستخراج حالته الهندسية والفجوات',
    capabilities: ['workspace.read'], risk: 'low',
    sandbox: { required: true, profile: { network: false, filesystem: 'workspace-read-only' } },
    execute: async () => new ProjectBuilderAgent({ projectRoot, policy: readOnlyPolicy }).audit()
  });
  const proposeChanges = new ToolInterface({
    name: 'project.propose_changes', description: 'تحليل مشروع قراءة فقط واكتشاف مشكلة فعلية ثم إنتاج Change Proposal آمن بدون تنفيذ',
    capabilities: ['workspace.read'], risk: 'low',
    sandbox: { required: true, profile: { network: false, filesystem: 'workspace-read-only' } },
    execute: async () => {
      const agent = new ProjectBuilderAgent({ projectRoot, policy: readOnlyPolicy });
      const analyzer = new ProjectImprovementAnalyzer({ workspace: agent.workspace, discovery: agent.discovery });
      return analyzer.analyze();
    }
  });
  const executeChange = new ToolInterface({
    name: 'project.execute_change',
    description: 'تنفيذ Change Proposal معتمد داخل مساحة العمل المقيدة ثم التحقق والرجوع تلقائيًا عند فشل التحقق',
    capabilities: ['workspace.write'],
    risk: 'high',
    sandbox: { required: true, profile: { filesystem: { allowRead: [projectRoot], allowWrite: [projectRoot] }, network: { allowedDomains: [] }, unixSockets: { allowed: [] } } },
    execute: async (input = {}) => {
      const proposalResult = input && input.proposals ? input : input;
      const proposals = Array.isArray(proposalResult.proposals) ? proposalResult.proposals : [];
      if (proposals.length === 0) throw new Error('No approved change proposals were supplied');

      const agent = new ProjectBuilderAgent({
        projectRoot,
        policy: {
          ...policy,
          allowRead: true,
          allowWrite: true,
          allowCommands: true,
          allowGit: false,
          allowedCommands: ['node'],
          timeoutMs: policy.timeoutMs || 120000
        }
      });

      const commandRunner = new CommandRunner({ policy: agent.policy });
      const commandVerification = new CommandVerification({ commandRunner });
      const checks = proposals.map((proposal, index) => ({
        id: 'proposal-applied-' + index,
        run: async ({ workspace }) => ({
          passed: await workspace.exists(proposal.path) && (await workspace.readText(proposal.path)) === proposal.content
        })
      }));

      const hasTests = await agent.workspace.exists('test');
      if (hasTests) checks.push(commandVerification.createCheck({ id: 'node-test-suite', executable: 'node', args: ['--test'] }));

      return agent.execute({
        plan: { mission: 'PROJECT_CHANGE_EXECUTION' },
        changeSet: { changes: proposals },
        definitionOfDone: { allProposalsApplied: true, verificationPassed: true, rollbackOnFailure: true },
        checks
      });
    },
    reconcile: async (input = {}) => {
      const proposals = Array.isArray(input.proposals) ? input.proposals : [];
      if (proposals.length === 0) return { status: 'conflict', reason: 'no_change_proposals' };

      const workspaceAgent = new ProjectBuilderAgent({
        projectRoot,
        policy: { ...policy, allowRead: true, allowWrite: false, allowCommands: false, allowGit: false }
      });

      const observations = [];
      let allApplied = true;

      for (const proposal of proposals) {
        const exists = await workspaceAgent.workspace.exists(proposal.path);
        const actual = exists ? await workspaceAgent.workspace.readText(proposal.path) : null;
        const applied = exists && actual === proposal.content;
        observations.push({ path: proposal.path, applied });
        if (!applied) allApplied = false;
      }

      if (allApplied) {
        return {
          status: 'completed',
          result: {
            status: 'verified',
            reconciled: true,
            modification: { applied: true, reconciled: true, changes: proposals.map(({ action, path, content }) => ({ action, path, content })) },
            verification: {
              status: 'reconciled',
              passed: observations.length,
              failed: 0,
              definitionOfDoneSatisfied: true,
              checks: observations.map((observation, index) => ({
                id: 'proposal-applied-' + index,
                passed: observation.applied,
                result: observation
              }))
            },
            recovery: { operationId: null, observations }
          }
        };
      }

      return {
        status: 'conflict',
        reason: 'external_state_does_not_match_expected_post_state',
        observations
      };
    }
  });

  return [audit, proposeChanges, executeChange];
}
module.exports = createProjectTools;
