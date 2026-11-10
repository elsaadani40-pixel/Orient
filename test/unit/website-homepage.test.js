'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const homepagePath = path.join(__dirname, '../../website/index.html');

function bootHomepage({ reducedMotion = false, browserLanguage = 'en', savedLanguage = null, hostname = 'localhost' } = {}) {
  const html = fs.readFileSync(homepagePath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const script = scripts.find(source => source.includes("orient-language"));
  assert.ok(script, 'homepage initialization script should exist');

  const listeners = new Map();
  const storage = new Map();
  if (savedLanguage) storage.set('orient-language', savedLanguage);
  const element = () => ({
    textContent: '',
    innerHTML: '',
    hidden: false,
    href: '',
    dataset: {},
    attributes: {},
    classList: (() => { const values = new Set(); return { toggle(name, force) { const shouldAdd = force === undefined ? !values.has(name) : Boolean(force); if (shouldAdd) values.add(name); else values.delete(name); return shouldAdd; }, add(name) { values.add(name); }, remove(name) { values.delete(name); }, contains(name) { return values.has(name); } }; })(),
    addEventListener(name, callback) { listeners.set(this.id + ':' + name, callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    focus() { this.focused = true; }
  });
  const ids = ['lang', 'menu', 'navlinks', 'authAction'];
  const elements = Object.fromEntries(ids.map(id => [id, { ...element(), id }]));
  elements.menu.attributes['aria-expanded'] = 'false';
  elements.menu.attributes['aria-controls'] = 'navlinks';
  const document = {
    body: { classList: { toggle() {} } },
    documentElement: { lang: '', dir: '' },
    getElementById(id) { return elements[id] || null; },
    addEventListener(name, callback) { listeners.set('document:' + name, callback); },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };
  const fetchCalls = [];
  const context = {
    document,
    location: { hostname },
    window: { matchMedia: () => ({ matches: reducedMotion }) },
    navigator: { language: browserLanguage },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, value); }
    },
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    },
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(script, context, { filename: 'website/index.html:inline-script' });
  return { document, elements, listeners, storage, fetchCalls };
}

test('homepage initializes language and account navigation when reduced motion is enabled', () => {
  const app = bootHomepage({ reducedMotion: true, browserLanguage: 'ar' });
  assert.equal(app.document.documentElement.lang, 'ar');
  assert.equal(app.document.documentElement.dir, 'rtl');
  assert.equal(app.elements.lang.textContent, 'English');
  assert.equal(app.fetchCalls.length, 1);
  assert.equal(app.fetchCalls[0].url, '/api/auth/me');
  assert.equal(app.elements.authAction.hidden, false);
});

test('homepage restores a saved language and persists the next selection', () => {
  const app = bootHomepage({ savedLanguage: 'ar', browserLanguage: 'en' });
  assert.equal(app.document.documentElement.lang, 'ar');
  app.listeners.get('lang:click')();
  assert.equal(app.document.documentElement.lang, 'en');
  assert.equal(app.storage.get('orient-language'), 'en');
});

test('homepage defaults to English when no Arabic preference is available', () => {
  const app = bootHomepage({ browserLanguage: 'en' });
  assert.equal(app.document.documentElement.lang, 'en');
  assert.equal(app.document.documentElement.dir, 'ltr');
});


test('mobile navigation exposes expanded state and closes on Escape with focus restored', () => {
  const app = bootHomepage({ reducedMotion: true });
  const menu = app.elements.menu;
  const nav = app.elements.navlinks;
  const click = app.listeners.get('menu:click');
  const keydown = app.listeners.get('document:keydown');

  assert.equal(menu.attributes['aria-expanded'], 'false');
  assert.equal(menu.attributes['aria-controls'], 'navlinks');
  assert.equal(nav.classList.contains('open'), false);
  assert.equal(typeof click, 'function');
  assert.equal(typeof keydown, 'function');

  click();
  assert.equal(nav.classList.contains('open'), true);
  assert.equal(menu.attributes['aria-expanded'], 'true');
  assert.equal(menu.attributes['aria-label'], 'Close navigation');

  keydown({ key: 'Escape' });
  assert.equal(nav.classList.contains('open'), false);
  assert.equal(menu.attributes['aria-expanded'], 'false');
  assert.equal(menu.focused, true);
});

test('public landing pages do not expose local-only account routes or call the local auth API', () => {
  const app = bootHomepage({ hostname: 'orient.example' });
  assert.equal(app.elements.authAction.hidden, true);
  assert.equal(app.fetchCalls.length, 0);
});
