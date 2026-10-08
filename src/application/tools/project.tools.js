const ToolInterface = require('../../core/tools/tool.interface');
const ProjectBuilderAgent = require('../../core/agent/project-builder/project-builder-agent');

function createProjectTools({ projectRoot, policy = {} } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new TypeError('projectRoot is required');
  }

  const audit = new ToolInterface({
    name: 'project.audit',
    description: 'فحص مشروع محلي قراءة فقط واستخراج حالته الهندسية والفجوات',
    capabilities: ['workspace.read'],
    risk: 'low',
    sandbox: { required: true, profile: { network: false, filesystem: 'workspace-read-only' } },
    execute: async () => {
      const agent = new ProjectBuilderAgent({
        projectRoot,
        policy: {
          ...policy,
          allowRead: true,
          allowWrite: false,
          allowCommands: false,
          allowGit: false
        }
      });

      return agent.audit();
    }
  });

  return [audit];
}

module.exports = createProjectTools;
