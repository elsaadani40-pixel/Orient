'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const publicPages = [
  'website/index.html',
  'website/auth.html',
  'website/account.html',
  'website/owner.html',
  'website/dashboard.html'
];

test('public website pages use the ORIENT brand consistently', () => {
  for (const relativePath of publicPages) {
    const html = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(html, /ORIENT ONE/, relativePath);
    assert.match(html, /ORIENT/, relativePath);
  }
});

test('contributor and security policies use the current ORIENT brand', () => {
  for (const relativePath of ['CONTRIBUTING.md', 'SECURITY.md']) {
    const document = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(document, /ORIENT ONE/, relativePath);
  }
});
