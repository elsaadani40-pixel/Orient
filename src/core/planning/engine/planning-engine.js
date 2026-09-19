const ExecutionGraph = require('../graph/execution-graph');
const ExecutionNode = require('../graph/execution-node');

class PlanningEngine {
  create({ goalId, steps = [] }) {
    const graph = new ExecutionGraph({ goalId });

    for (const step of steps) {
      graph.addNode(
        new ExecutionNode({
          tool: step.tool,
          input: step.input,
          dependencies: step.dependencies || []
        })
      );
    }

    return graph;
  }
}

module.exports = PlanningEngine;
