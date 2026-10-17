const test = require('node:test');
const assert = require('node:assert/strict');

const packageMetadata = require('../../../package.json');
const version = require('../../../src/core/version');
const config = require('../../../src/core/config');

test('package metadata is the canonical ORIENT ONE version', () => {
  // Accept stable SemVer and prerelease identifiers such as 0.1.0-alpha.
  assert.match(packageMetadata.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(version, packageMetadata.version);
});

test('runtime configuration exposes the canonical application version', () => {
  assert.equal(config.version, packageMetadata.version);
});
