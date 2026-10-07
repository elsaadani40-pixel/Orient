const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowDefinition = require('../../../../src/core/workflow/workflow-definition');
const WorkflowInstance = require('../../../../src/core/workflow/workflow-instance');

function instance() {
  return new WorkflowInstance({
    definition: new WorkflowDefinition({
      id: 'definition-1',
      version: 1,
      name: 'Lifecycle Test',
      steps: [{ id: 'step-1' }]
    })
  });
}

test('WorkflowInstance enforces explicit workflow lifecycle transitions', () => {
  const workflow = instance();
  workflow.transition(WorkflowInstance.STATES.QUEUED);
  workflow.transition(WorkflowInstance.STATES.RUNNING);
  workflow.transition(WorkflowInstance.STATES.RECOVERING);
  workflow.transition(WorkflowInstance.STATES.RUNNING);
  workflow.transition(WorkflowInstance.STATES.COMPLETED);

  assert.throws(
    () => workflow.transition(WorkflowInstance.STATES.RUNNING),
    (error) => error.code === 'WORKFLOW_INVALID_TRANSITION'
  );
});

test('WorkflowInstance rejects unknown persisted lifecycle states during recovery', () => {
  const workflow = instance().toJSON();
  workflow.state = 'AGENT_EXECUTING';

  assert.throws(
    () => WorkflowInstance.fromJSON(workflow),
    (error) => error.code === 'WORKFLOW_INVALID_STATE'
  );
});

test('workflow lifecycle remains distinct from agent lifecycle values', () => {
  assert.equal(
    Object.values(WorkflowInstance.STATES).includes('executing'),
    false
  );
  const AgentState = require('../../../../src/core/agent/state/agent-state');
  const workflowStates = new Set(Object.values(WorkflowInstance.STATES));
  const agentStates = new Set(Object.values(AgentState.LIFECYCLE));
  assert.equal(
    [...workflowStates].some((state) => agentStates.has(state)),
    false
  );
});
