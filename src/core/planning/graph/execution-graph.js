const crypto = require('crypto');

class ExecutionGraph {
  constructor({ id = crypto.randomUUID(), goalId, nodes = [], edges = [] } = {}) {
    if (!goalId) {
      throw new Error('goalId is required');
    }

    this.id = id;
    this.goalId = goalId;
    this.version = 1;
    this.nodes = [...nodes];
    this.edges = [...edges];
  }

  addNode(node) {
    this.nodes.push(node);
    return node;
  }

  addEdge(from, to) {
    this.edges.push({ from, to });
  }

  toJSON() {
    return {
      id: this.id,
      goalId: this.goalId,
      version: this.version,
      nodes: this.nodes.map((node) =>
        typeof node.toJSON === 'function' ? node.toJSON() : node
      ),
      edges: this.edges
    };
  }
}

module.exports = ExecutionGraph;
