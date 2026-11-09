'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../website/orient-theme.js'), 'utf8');

function createHarness({ stored = null, systemDark = true, storageThrows = false } = {}) {
  const values = new Map();
  if (stored !== null) values.set('orient.theme.preference', stored);
  const meta = { content: '' };
  const listeners = {};
  const mediaListeners = [];
  const root = { dataset: {} };
  const toggle = {
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  };
  const document = {
    documentElement: root,
    readyState: 'complete',
    body: { appendChild(element) { this.child = element; } },
    querySelector(selector) { return selector === 'meta[name="color-scheme"]' ? meta : null; },
    createElement(tag) { assert.equal(tag, 'button'); return toggle; },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const media = {
    matches: systemDark,
    addEventListener(name, callback) { mediaListeners.push(callback); }
  };
  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error('storage unavailable');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (storageThrows) throw new Error('storage unavailable');
      values.set(key, value);
    }
  };
  vm.runInNewContext(source, {
    document,
    window: { matchMedia: () => media },
    localStorage
  });
  return { root, meta, toggle, media, mediaListeners, values, document };
}

test('theme control follows system preference and exposes an accessible name', () => {
  const h = createHarness({ systemDark: true });
  assert.equal(h.root.dataset.orientTheme, 'dark');
  assert.equal(h.meta.content, 'dark');
  assert.equal(h.document.body.child, h.toggle);
  assert.equal(h.toggle.type, 'button');
  assert.match(h.toggle.attributes['aria-label'], /تلقائي/);
  assert.equal(Object.hasOwn(h.toggle.attributes, 'aria-pressed'), false);
});

test('theme control cycles system, light, dark and persists each preference', () => {
  const h = createHarness({ systemDark: true });
  h.toggle.listeners.click();
  assert.equal(h.root.dataset.orientTheme, 'light');
  assert.equal(h.values.get('orient.theme.preference'), 'light');
  h.toggle.listeners.click();
  assert.equal(h.root.dataset.orientTheme, 'dark');
  assert.equal(h.values.get('orient.theme.preference'), 'dark');
  h.toggle.listeners.click();
  assert.equal(h.root.dataset.orientTheme, 'dark');
  assert.equal(h.values.get('orient.theme.preference'), 'system');
  assert.match(h.toggle.attributes['aria-label'], /تلقائي/);
});

test('system preference changes are observed only while system mode is selected', () => {
  const h = createHarness({ systemDark: true });
  h.media.matches = false;
  for (const listener of h.mediaListeners) listener();
  assert.equal(h.root.dataset.orientTheme, 'light');
  h.toggle.listeners.click();
  h.media.matches = true;
  for (const listener of h.mediaListeners) listener();
  assert.equal(h.root.dataset.orientTheme, 'light');
  h.toggle.listeners.click();
  h.toggle.listeners.click();
  assert.equal(h.root.dataset.orientTheme, 'dark');
});

test('theme control remains usable when browser storage is unavailable', () => {
  const h = createHarness({ storageThrows: true, systemDark: false });
  assert.equal(h.root.dataset.orientTheme, 'light');
  assert.doesNotThrow(() => h.toggle.listeners.click());
  assert.equal(h.root.dataset.orientTheme, 'light');
});
