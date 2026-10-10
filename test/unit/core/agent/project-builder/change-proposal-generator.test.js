'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ChangeProposalGenerator = require('../../../../../src/core/agent/project-builder/change-proposal/change-proposal-generator');

test('change proposal generator preserves update preconditions for approval-bound execution', () => {
  const expectedContentSha256 = 'a'.repeat(64);
  const result = new ChangeProposalGenerator().generate({
    buildPlan: { goal: 'Update a file' },
    proposals: [{
      action: 'update',
      path: 'src/example.js',
      content: 'updated',
      expectedContentSha256
    }]
  });

  assert.equal(result.proposals[0].expectedContentSha256, expectedContentSha256);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.generated, false);
});
