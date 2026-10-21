const test = require('node:test');
const assert = require('node:assert/strict');

const createAgentRoutes = require('../../src/interfaces/http/routes/agent.routes');

function responseStub() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    }
  };
}

test('approval decision route forwards server-derived owner identity and exact scope', async () => {
  let received;
  const routes = createAgentRoutes({
    decideApproval: async value => {
      received = value;
      return { approvalId: value.approvalId, executionId: value.executionId, decision: { status: value.decision } };
    }
  });
  const res = responseStub();

  await routes.decideApproval(
    { method: 'POST' },
    res,
    'approval_123',
    { executionId: 'execution_456', decision: 'approved' },
    'owner:Admin'
  );

  assert.deepEqual(received, {
    approvalId: 'approval_123',
    executionId: 'execution_456',
    decision: 'approved',
    actorId: 'owner:Admin'
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('approval decision route rejects non-owner actor identities', async () => {
  const routes = createAgentRoutes({
    decideApproval: async () => {
      throw new Error('must not be called');
    }
  });
  await assert.rejects(
    routes.decideApproval(
      {},
      responseStub(),
      'approval_123',
      { executionId: 'execution_456', decision: 'approved' },
      'public:user-1'
    ),
    error => error.code === 'APPROVAL_DECISION_FORBIDDEN' && error.statusCode === 403
  );
});

test('approval decision route rejects malformed decision scope', async () => {
  const routes = createAgentRoutes({ decideApproval: async () => { throw new Error('must not be called'); } });
  await assert.rejects(
    routes.decideApproval({}, responseStub(), 'approval_123', { executionId: '', decision: 'approve' }, 'owner:Admin'),
    error => error.code === 'INVALID_APPROVAL_DECISION' && error.statusCode === 400
  );
});
