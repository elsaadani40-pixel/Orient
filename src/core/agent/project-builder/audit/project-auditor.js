const AuditResult = require('./audit-result');

class ProjectAuditor {
  constructor({ workspace, discovery }) {
    if (!workspace) {
      throw new TypeError('workspace is required');
    }

    if (!discovery) {
      throw new TypeError('discovery is required');
    }

    this.workspace = workspace;
    this.discovery = discovery;
  }

  async audit() {
    const discovered = await this.discovery.discover();

    const findings = [];
    const gaps = [];
    const strengths = [];

    const rootFiles = new Set(discovered.files);

    const hasSrc = rootFiles.has('src');
    const hasTest = rootFiles.has('test');
    const hasAgentInstructions =
      discovered.instructions.includes('AGENT.md');
    const hasGit = discovered.git.detected;
    const hasManifest = discovered.manifest.files.length > 0;

    if (hasSrc) {
      strengths.push({
        id: 'source-directory',
        message: 'Source directory detected.'
      });
    } else {
      gaps.push({
        id: 'missing-source-directory',
        severity: 'warning',
        message: 'No src/ directory detected at project root.'
      });
    }

    if (hasTest) {
      strengths.push({
        id: 'test-directory',
        message: 'Test directory detected.'
      });
    } else {
      gaps.push({
        id: 'missing-test-directory',
        severity: 'warning',
        message: 'No test/ directory detected at project root.'
      });
    }

    if (hasAgentInstructions) {
      strengths.push({
        id: 'engineering-instructions',
        message: 'AGENT.md detected.'
      });
    } else {
      gaps.push({
        id: 'missing-agent-instructions',
        severity: 'info',
        message: 'No AGENT.md detected.'
      });
    }

    if (hasGit) {
      strengths.push({
        id: 'git',
        message: 'Git repository detected.'
      });
    } else {
      gaps.push({
        id: 'missing-git',
        severity: 'warning',
        message: 'Git repository not detected.'
      });
    }

    if (hasManifest) {
      strengths.push({
        id: 'manifest',
        message: 'Project manifest detected.'
      });
    } else {
      gaps.push({
        id: 'missing-project-manifest',
        severity: 'warning',
        message: 'No supported project manifest detected.'
      });
    }

    findings.push({
      id: 'project-identity',
      type: 'project',
      stack: discovered.detectedStack,
      manifests: discovered.manifest.files
    });

    findings.push({
      id: 'repository',
      type: 'repository',
      gitDetected: hasGit,
      files: discovered.files
    });

    findings.push({
      id: 'engineering-governance',
      type: 'governance',
      instructionFiles: discovered.instructions
    });

    const criticalGaps = gaps.filter(
      gap => gap.severity === 'critical'
    );

    const status =
      criticalGaps.length > 0
        ? 'blocked'
        : gaps.length > 0
          ? 'needs-work'
          : 'healthy';

    const severityWeights = { critical: 0, warning: 60, info: 90 };
    const score = gaps.length === 0
      ? 100
      : Math.max(
          0,
          Math.round(
            gaps.reduce((total, gap) => total + (severityWeights[gap.severity] ?? 80), 0) /
              gaps.length
          )
        );
    const recommendation =
      status === 'healthy'
        ? 'safe-to-proceed'
        : status === 'blocked'
          ? 'stop-and-remediate-critical-gaps'
          : 'remediate-gaps-before-production-change';

    const definitionOfDone = {
      required: [
        'Project structure is understood.',
        'Engineering instructions are identified.',
        'Project type and manifests are identified.',
        'Existing tests are identified.',
        'Git state is understood.',
        'Audit result is internally consistent.'
      ],
      satisfied: true
    };

    return new AuditResult({
      status,
      projectType:
        discovered.detectedStack.length > 0
          ? discovered.detectedStack[0]
          : 'unknown',
      findings,
      gaps,
      strengths,
      definitionOfDone,
      score,
      recommendation
    }).toJSON();
  }
}

module.exports = ProjectAuditor;
