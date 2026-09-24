class AuditResult {
  constructor({
    status = 'unknown',
    projectType = 'unknown',
    findings = [],
    gaps = [],
    strengths = [],
    definitionOfDone = null
  } = {}) {
    this.status = status;
    this.projectType = projectType;
    this.findings = findings;
    this.gaps = gaps;
    this.strengths = strengths;
    this.definitionOfDone = definitionOfDone;
  }

  toJSON() {
    return {
      status: this.status,
      projectType: this.projectType,
      findings: this.findings,
      gaps: this.gaps,
      strengths: this.strengths,
      definitionOfDone: this.definitionOfDone
    };
  }
}

module.exports = AuditResult;
