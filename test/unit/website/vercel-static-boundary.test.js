'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../../..');
const websiteRoot = path.join(repositoryRoot, 'website');
const vercelIgnorePath = path.join(websiteRoot, '.vercelignore');

test('Vercel static deployment excludes authenticated account and owner pages', () => {
  const ignore = fs.readFileSync(vercelIgnorePath, 'utf8');
  const excluded = new Set(ignore.split(/\r?\n/).map(line => line.trim()));

  for (const file of ['owner.html', 'dashboard.html', 'account.html']) {
    assert.ok(fs.existsSync(path.join(websiteRoot, file)), `${file} remains available to the authenticated application server`);
    assert.ok(excluded.has(`/${file}`), `${file} must be excluded from the public Vercel static artifact`);
  }

  assert.ok(fs.existsSync(path.join(websiteRoot, 'index.html')), 'the public landing page must remain deployable');
  assert.ok(fs.existsSync(path.join(websiteRoot, 'auth.html')), 'the public authentication entry page must remain deployable');
});
