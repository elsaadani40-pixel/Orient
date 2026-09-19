function registerDefaultToolCapabilities(mapper) {
  if (!mapper) {
    throw new TypeError(
      'capabilityMapper is required'
    );
  }

  const mappings = {
    'memory.search': 'memory.read',
    'memory.list': 'memory.read',
    'memory.add': 'memory.write',
    'memory.delete': 'memory.delete'
  };

  for (const [tool, capability] of Object.entries(mappings)) {
    if (!mapper.has(tool)) {
      mapper.register(
        tool,
        capability
      );
    }
  }

  return mapper;
}

module.exports = registerDefaultToolCapabilities;
