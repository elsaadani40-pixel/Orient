const { AgentDefinition } = require('../boundary/agent-definition');
const DEFAULT_AGENTS = Object.freeze([
  new AgentDefinition({ id: 'MEMORY_AGENT', name: 'ORIENT Memory Agent', version: 1, description: 'Specialized agent for scoped personal memory operations.', capabilities: ['tool:memory.search','tool:memory.list','tool:memory.add','tool:memory.delete','memory.read','memory.write','memory.delete','model:text-generation'], allowedMemoryScopes: ['personal', 'shared.memory'], allowedAgentTargets: ['RESEARCH_AGENT'], risk: 'medium' }),
  new AgentDefinition({ id: 'RESEARCH_AGENT', name: 'ORIENT Research Agent', version: 1, description: 'Research and reasoning agent operating through approved tools and local models.', capabilities: ['tool:memory.search','tool:memory.list','memory.read','model:text-generation'], allowedMemoryScopes: ['personal', 'shared.research'], allowedAgentTargets: ['MEMORY_AGENT'], risk: 'medium' }),
  new AgentDefinition({ id: 'PROJECT_BUILDER_AGENT', name: 'ORIENT Project Builder Agent', version: 1, description: 'Read-only project analysis and change-proposal specialist; modification and command execution remain policy-gated.', capabilities: ['tool:project.audit','tool:project.propose_changes','workspace.read','model:text-generation'], allowedMemoryScopes: ['shared.project'], allowedAgentTargets: [], risk: 'low' }),
  new AgentDefinition({ id: 'ORIENT_RUNTIME', name: 'ORIENT Canonical Runtime', version: 1, description: 'Canonical execution authority. Not a user-facing specialist.', capabilities: ['*'], allowedMemoryScopes: ['*'], allowedAgentTargets: ['*'], risk: 'critical' })
]);
function registerDefaultAgents(registry) {
  if (!registry) throw new TypeError('agentRegistry is required');
  for (const agent of DEFAULT_AGENTS) if (!registry.get(agent.id)) registry.register(agent);
  return registry;
}
module.exports = { DEFAULT_AGENTS, registerDefaultAgents };
