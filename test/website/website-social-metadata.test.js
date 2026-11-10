'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'website', 'index.html'),
  'utf8'
);

test('ORIENT website exposes accurate Open Graph metadata', () => {
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="ORIENT">/);
  assert.match(html, /<meta property="og:title" content="ORIENT — Intelligence, in motion\.">/);
  assert.match(html, /<meta property="og:description" content="A governed, local-first personal AI operating system in active development\.">/);
});

test('ORIENT website declares English and Arabic sharing locales', () => {
  assert.match(html, /<meta property="og:locale" content="en_US">/);
  assert.match(html, /<meta property="og:locale:alternate" content="ar_EG">/);
});

test('ORIENT website exposes a truthful Twitter summary card', () => {
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.match(html, /<meta name="twitter:title" content="ORIENT — Intelligence, in motion\.">/);
  assert.match(html, /<meta name="twitter:description" content="A governed, local-first personal AI operating system in active development\.">/);
});
