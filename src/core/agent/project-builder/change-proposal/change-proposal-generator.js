class ChangeProposalGenerator {
  generate({
    buildPlan,
    proposals = []
  } = {}) {
    if (!buildPlan || typeof buildPlan !== 'object') {
      throw new TypeError('buildPlan is required');
    }

    if (!Array.isArray(proposals)) {
      throw new TypeError('proposals must be an array');
    }

    return {
      goal: buildPlan.goal ?? null,
      proposals: proposals.map((proposal) => ({
        action: proposal.action,
        path: proposal.path,
        content: proposal.content ?? '',
        ...(typeof proposal.expectedContentSha256 === 'string'
          ? { expectedContentSha256: proposal.expectedContentSha256.toLowerCase() }
          : {})
      })),
      requiresApproval: proposals.length > 0,
      generated: false
    };
  }
}

module.exports = ChangeProposalGenerator;
