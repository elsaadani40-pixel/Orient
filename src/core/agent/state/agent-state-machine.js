const AgentState = require('./agent-state');

const {
  CREATED,
  UNDERSTANDING,
  PLANNING,
  VALIDATING,
  EXECUTING,
  OBSERVING,
  EVALUATING,
  RECOVERING,
  WAITING,
  COMPLETED,
  FAILED,
  CANCELLED
} = AgentState.LIFECYCLE;

const TRANSITIONS = Object.freeze({
  [CREATED]: new Set([
    UNDERSTANDING,
    FAILED,
    CANCELLED
  ]),

  [UNDERSTANDING]: new Set([
    PLANNING,
    FAILED,
    CANCELLED
  ]),

  [PLANNING]: new Set([
    VALIDATING,
    FAILED,
    CANCELLED
  ]),

  [VALIDATING]: new Set([
    EXECUTING,
    FAILED,
    CANCELLED
  ]),

  [EXECUTING]: new Set([
    OBSERVING,
    FAILED,
    CANCELLED
  ]),

  [OBSERVING]: new Set([
    EVALUATING,
    FAILED,
    CANCELLED
  ]),

  [EVALUATING]: new Set([
    COMPLETED,
    PLANNING,
    EXECUTING,
    RECOVERING,
    WAITING,
    FAILED,
    CANCELLED
  ]),

  [RECOVERING]: new Set([
    PLANNING,
    EXECUTING,
    FAILED,
    CANCELLED
  ]),

  [WAITING]: new Set([
    EXECUTING,
    FAILED,
    CANCELLED
  ]),

  [COMPLETED]: new Set(),

  [FAILED]: new Set(),

  [CANCELLED]: new Set()
});

class AgentStateMachine {
  constructor(state) {
    if (!(state instanceof AgentState)) {
      throw new TypeError(
        'AgentState is required'
      );
    }

    this.state = state;
  }

  canTransitionTo(nextState) {
    if (
      !Object.values(
        AgentState.LIFECYCLE
      ).includes(nextState)
    ) {
      return false;
    }

    const allowed =
      TRANSITIONS[
        this.state.lifecycle
      ];

    return Boolean(
      allowed &&
      allowed.has(nextState)
    );
  }

  transitionTo(nextState) {
    if (
      !Object.values(
        AgentState.LIFECYCLE
      ).includes(nextState)
    ) {
      throw new Error(
        `Invalid agent lifecycle "${nextState}"`
      );
    }

    if (
      !this.canTransitionTo(
        nextState
      )
    ) {
      throw new Error(
        `Invalid agent lifecycle transition: "${this.state.lifecycle}" -> "${nextState}"`
      );
    }

    this.state.transitionTo(
      nextState
    );

    return this.state;
  }

  getState() {
    return this.state.lifecycle;
  }

  is(state) {
    return (
      this.state.lifecycle === state
    );
  }

  getAllowedTransitions() {
    const allowed =
      TRANSITIONS[
        this.state.lifecycle
      ];

    return allowed
      ? [...allowed]
      : [];
  }
}

AgentStateMachine.TRANSITIONS =
  TRANSITIONS;

module.exports =
  AgentStateMachine;
