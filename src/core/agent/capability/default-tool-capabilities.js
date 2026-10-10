function registerDefaultToolCapabilities(mapper) {
  if (!mapper) throw new TypeError('capabilityMapper is required');

  const mappings = {
    'memory.search': 'memory.read',
    'memory.list': 'memory.read',
    'memory.add': 'memory.write',
    'memory.delete': 'memory.delete',
    'project.audit': 'workspace.read',
    'project.propose_changes': 'workspace.read',
    'project.execute_change': 'workspace.write',
    'workspace.read': 'workspace.read',
    'workspace.list': 'workspace.read',
    'workspace.search': 'workspace.read'
  };

  for (const [tool, capability] of Object.entries(mappings)) {
    if (!mapper.has(tool)) mapper.register(tool, capability);
  }

  return mapper;
}

module.exports = registerDefaultToolCapabilities;
