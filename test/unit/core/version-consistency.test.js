const test = require('node:test');
const assert = require('node:assert/strict');

const packageMetadata = require('../../../package.json');
const version = require('../../../src/core/version');
const config = require('../../../src/core/config');

test('package metadata is the canonical ORIENT ONE version', () => {
  assert.match(packageMetadata.version, /^\d+\.\d+\.\d+$/);
  assert.equal(version, packageMetadata.version);
});

test('runtime configuration exposes the canonical application version', () => {
  assert.equal(config.version, packageMetadata.version);
});
