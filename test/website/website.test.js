const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const websitePath = path.join(__dirname, '..', '..', 'website', 'index.html');
const html = fs.readFileSync(websitePath, 'utf8');

test('ORIENT website declares responsive, localized document metadata', () => {
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /name="description"/);
  assert.match(html, /<title>ORIENT/);
});

test('ORIENT website includes Arabic RTL switching and responsive layouts', () => {
  assert.match(html, /data-ar=/);
  assert.match(html, /document\.documentElement\.dir=ar\?'rtl':'ltr'/);
  assert.match(html, /@media\(max-width:900px\)/);
  assert.match(html, /@media\(max-width:560px\)/);
});

test('ORIENT website respects reduced-motion preferences', () => {
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
});

test('ORIENT website communicates active development without claiming full release', () => {
  assert.match(html, /Development status: ORIENT is actively being engineered/i);
  assert.match(html, /not a claim that every capability is released today/i);
  assert.match(html, /https:\/\/github\.com\/elsaadani40-pixel\/Orient/);
});
