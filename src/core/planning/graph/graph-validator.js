class GraphValidator {
  validate(graph) {
    if (!graph || !Array.isArray(graph.nodes)) {
      throw new Error('Invalid execution graph');
    }

    const ids = new Set();

    for (const node of graph.nodes) {
      if (!node || !node.id || !node.tool) {
        throw new Error('Invalid execution node');
      }

      if (ids.has(node.id)) {
        throw new Error('Duplicate execution node');
      }

      ids.add(node.id);
    }

    for (const node of graph.nodes) {
      for (const dependency of node.dependencies || []) {
        if (!ids.has(dependency)) {
          throw new Error('Unknown node dependency');
        }

        if (dependency === node.id) {
          throw new Error('Node cannot depend on itself');
        }
      }
    }

    return true;
  }
}

module.exports = GraphValidator;
