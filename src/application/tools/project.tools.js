const crypto = require('node:crypto');
const path = require('node:path');
const ToolInterface = require('../../core/tools/tool.interface');
const ProjectBuilderAgent = require('../../core/agent/project-builder/project-builder-agent');
const ProjectImprovementAnalyzer = require('../../core/agent/project-builder/change-proposal/project-improvement-analyzer');
const CommandRunner = require('../../core/agent/project-builder/workspace/command-runner');
const CommandVerification = require('../../core/agent/project-builder/verification/command-verification');

function createProjectTools({ projectRoot, policy = {}, operationReceiptStore = null } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') throw new TypeError('projectRoot is required');
  const readOnlyPolicy = { ...policy, allowRead: true, allowWrite: false, allowCommands: false, allowGit: false };
  const audit = new ToolInterface({
    name: 'project.audit', description: 'فحص مشروع محلي قراءة فقط واستخراج حالته الهندسية والفجوات',
    capabilities: ['workspace.read'], risk: 'low',
    sandbox: { required: true, profile: { network: false, filesystem: 'workspace-read-only' } },
    effects: 'read_only',
    idempotency: 'idempotent',
    execute: async () => new ProjectBuilderAgent({ projectRoot, policy: readOnlyPolicy }).audit()
  });
  const proposeChanges = new ToolInterface({
    name: 'project.propose_changes', description: 'تحليل مشروع قراءة فقط واكتشاف مشكلة فعلية ثم إنتاج Change Proposal آمن بدون تنفيذ',
    capabilities: ['workspace.read'], risk: 'low',
    sandbox: { required: true, profile: { network: false, filesystem: 'workspace-read-only' } },
    effects: 'read_only',
    idempotency: 'idempotent',
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
    effects: 'local_mutation',
    idempotency: 'unknown',
    execute: async (input = {}, context = {}) => {
      const proposalResult = input && input.proposals ? input : input;
      const proposals = Array.isArray(proposalResult.proposals) ? proposalResult.proposals : [];
      if (proposals.length === 0) throw new Error('No approved change proposals were supplied');
      const operationId = typeof context.operationId === 'string' ? context.operationId : '';
      const tenantId = typeof context.tenantId === 'string' ? context.tenantId : '';
      if (operationReceiptStore && (!operationId || !tenantId)) {
        const error = new Error('Durable operation identity is required before project mutation');
        error.code = 'PROJECT_OPERATION_IDENTITY_REQUIRED';
        throw error;
      }
      const workspaceId = require('node:crypto').createHash('sha256').update(path.resolve(projectRoot), 'utf8').digest('hex');
      const changeSetHash = require('node:crypto').createHash('sha256').update(JSON.stringify(proposals.map(({ action, path: proposalPath, content, expectedContentSha256 }) => ({
        action, path: proposalPath, content, ...(expectedContentSha256 ? { expectedContentSha256 } : {})
      }))), 'utf8').digest('hex');

      const agent = new ProjectBuilderAgent({
        projectRoot,
        policy: {
          ...policy,
          allowRead: true,
          allowWrite: true,
          // Never elevate command execution beyond the caller's explicit policy.
          // Project-controlled tests remain disabled unless outer policy allows them.
          allowCommands: policy.allowCommands === true,
          allowGit: false,
          allowedCommands: Array.isArray(policy.allowedCommands) ? policy.allowedCommands : [],
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

      const canRunNodeTests = agent.policy.allowCommands === true &&
        agent.policy.allowedCommands.has('node');
      const hasTests = canRunNodeTests && await agent.workspace.exists('test');
      if (hasTests) checks.push(commandVerification.createCheck({ id: 'node-test-suite', executable: 'node', args: ['--test'] }));

      const result = await agent.execute({
        plan: { mission: 'PROJECT_CHANGE_EXECUTION' },
        changeSet: { changes: proposals },
        definitionOfDone: { allProposalsApplied: true, verificationPassed: true, rollbackOnFailure: true },
        checks
      });
      const serialized = typeof result?.toJSON === 'function' ? result.toJSON() : result;
      if (operationReceiptStore && serialized?.status === 'verified' &&
          serialized?.verification?.status === 'passed' && serialized?.verification?.failed === 0) {
        operationReceiptStore.write({ operationId, tenantId, workspaceId, changeSetHash, result: serialized });
      }
      return result;
    },
    reconcile: async (input = {}, context = {}) => {
      const proposals = Array.isArray(input.proposals) ? input.proposals : [];
      if (proposals.length === 0) return { status: 'conflict', reason: 'no_change_proposals' };
      const operationId = typeof context.operationId === 'string' ? context.operationId : '';
      const tenantId = typeof context.tenantId === 'string' ? context.tenantId : '';
      if (!operationReceiptStore || !operationId || !tenantId) {
        return { status: 'conflict', reason: 'operation_receipt_missing' };
      }
      const workspaceId = require('node:crypto').createHash('sha256').update(path.resolve(projectRoot), 'utf8').digest('hex');
      const changeSetHash = require('node:crypto').createHash('sha256').update(JSON.stringify(proposals.map(({ action, path: proposalPath, content, expectedContentSha256 }) => ({
        action, path: proposalPath, content, ...(expectedContentSha256 ? { expectedContentSha256 } : {})
      }))), 'utf8').digest('hex');
      let receipt;
      try {
        receipt = operationReceiptStore.read({ operationId, tenantId });
      } catch (error) {
        return { status: 'conflict', reason: error.code || 'operation_receipt_invalid' };
      }
      if (!receipt) return { status: 'conflict', reason: 'operation_receipt_missing' };
      if (receipt.workspaceId !== workspaceId || receipt.changeSetHash !== changeSetHash) {
        return { status: 'conflict', reason: 'operation_receipt_identity_conflict' };
      }

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

      // Observed matching files do not prove this operation applied them.
      // Without a durable operation receipt, fail closed rather than claim success.
      if (allApplied) {
        return {
          status: 'completed',
          result: receipt.result
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
