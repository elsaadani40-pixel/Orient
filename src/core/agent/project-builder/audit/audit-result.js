class AuditResult {
  constructor({
    status = 'unknown',
    projectType = 'unknown',
    findings = [],
    gaps = [],
    strengths = [],
    definitionOfDone = null,
    score = null,
    recommendation = null
  } = {}) {
    this.status = status;
    this.projectType = projectType;
    this.findings = findings;
    this.gaps = gaps;
    this.strengths = strengths;
    this.definitionOfDone = definitionOfDone;
    this.score = score;
    this.recommendation = recommendation;
  }

  toJSON() {
    return {
      status: this.status,
      projectType: this.projectType,
      findings: this.findings,
      gaps: this.gaps,
      strengths: this.strengths,
      definitionOfDone: this.definitionOfDone,
      score: this.score,
      recommendation: this.recommendation
    };
  }
}

module.exports = AuditResult;
