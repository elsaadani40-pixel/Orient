class ProjectImprovementAnalyzer {
  constructor({ workspace, discovery } = {}) {
    if (!workspace) throw new TypeError('workspace is required');
    if (!discovery) throw new TypeError('discovery is required');
    this.workspace = workspace;
    this.discovery = discovery;
  }
  async analyze() {
    const discovered = await this.discovery.discover();
    const findings = [];
    const proposals = [];
    const hasTestDirectory = discovered.files.includes('test') || await this.workspace.exists('test');
    if (discovered.manifest.files.includes('package.json')) {
      const raw = await this.workspace.readText('package.json');
      let manifest;
      try { manifest = JSON.parse(raw); } catch {
        findings.push({ id: 'invalid-package-json', severity: 'critical', type: 'manifest', path: 'package.json', message: 'package.json exists but is not valid JSON.' });
        return this.result({ discovered, findings, proposals });
      }
      const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
      if (hasTestDirectory && typeof scripts.test !== 'string') {
        const updated = { ...manifest, scripts: { ...scripts, test: 'node --test' } };
        findings.push({ id: 'missing-test-script', severity: 'warning', type: 'quality', path: 'package.json', evidence: { testDirectoryDetected: true, testScriptPresent: false }, message: 'A test directory exists but package.json does not expose a test script.' });
        proposals.push({ action: 'update', path: 'package.json', content: JSON.stringify(updated, null, 2) + '\n', reason: 'Expose the existing test suite through the standard package command.', expectedEffect: 'npm test will invoke the Node test runner.', risk: 'low' });
      }
    }
    return this.result({ discovered, findings, proposals });
  }
  result({ discovered, findings, proposals }) {
    return { status: findings.some(f => f.severity === 'critical') ? 'blocked' : findings.length > 0 ? 'actionable' : 'no-change-needed', findings, proposals, execution: { allowed: false, performed: false }, evidence: { projectRoot: discovered.projectRoot, manifest: discovered.manifest.files, detectedStack: discovered.detectedStack, files: discovered.files } };
  }
}
module.exports = ProjectImprovementAnalyzer;
