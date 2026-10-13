/**
 * Contract checks for the shipped ORIENT web surfaces.
 *
 * These checks intentionally use Node's built-in test runner so the project
 * does not need a browser dependency or a paid service just to validate the
 * static client contract. They complement (not replace) browser/device tests.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const brand = read('website/index.html');
const dashboard = read('src/interfaces/http/dashboard.html');
const ownerConsole = read('src/interfaces/http/owner-dashboard.html');
const ownerScript = read('src/interfaces/http/owner-dashboard.js');
const server = read('src/interfaces/http/server.js');

test('brand website has mobile metadata, bilingual content, and motion accessibility', () => {
  assert.match(brand, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(brand, /data-en=/);
  assert.match(brand, /data-ar=/);
  assert.match(brand, /prefers-reduced-motion:\s*reduce/);
  assert.match(brand, /id="lang"/);
  assert.match(brand, /document\.documentElement\.dir=ar\?'rtl':'ltr'/);
});

test('brand navigation targets real sections in the document', () => {
  const ids = new Set([...brand.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const anchors = [...brand.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(anchors.length > 0, 'expected in-page navigation links');
  for (const anchor of anchors) {
    assert.ok(ids.has(anchor), `navigation target #${anchor} must exist`);
  }
  assert.match(brand, /https:\/\/github\.com\/elsaadani40-pixel\/Orient/);
});

test('operational dashboard is responsive and exposes real runtime controls', () => {
  assert.match(dashboard, /<meta name="viewport"/);
  assert.match(dashboard, /@media/);
  assert.match(dashboard, /prefers-reduced-motion:\s*reduce/);
  assert.match(dashboard, /\/agent/);
  assert.match(dashboard, /\/executions/);
  assert.match(dashboard, /\/approvals\/pending/);
  assert.match(dashboard, /href="\/owner"/);
  assert.match(dashboard, /id="healthText" role="status" aria-live="polite"/);
  assert.match(dashboard, /\.status\{[^}]*flex-wrap:wrap/,
    'status text and owner link must wrap instead of overflowing narrow mobile viewports');
  assert.match(server, /requestUrl\.pathname === '\/owner'/);
  assert.match(dashboard, /EventSource|text\/event-stream|addEventListener\(['"]message['"]/);
  assert.doesNotMatch(dashboard, /<script[^>]+src=["']https?:\/\//i,
    'dashboard scripts must remain same-origin; no third-party script CDN');
});

test('owner console keeps password/session handling out of browser storage', () => {
  assert.match(ownerConsole, /id="login-form"/);
  assert.match(ownerConsole, /id="logout"/);
  assert.match(ownerConsole, /name="password"|id="password"/);
  assert.match(ownerScript, /credentials:\s*'same-origin'/);
  assert.match(ownerScript, /X-ORIENT-CSRF/);
  assert.doesNotMatch(ownerScript, /localStorage|sessionStorage/);
  assert.match(server, /HttpOnly; SameSite=Strict/);
  assert.match(server, /OWNER_CSRF_REJECTED/);
});

test('remote operational routes stay behind the owner-session boundary', () => {
  assert.match(server, /if \(ownerAuth\)/);
  assert.match(server, /OWNER_AUTH_REQUIRED/);
  assert.match(server, /OWNER_ORIGIN_REJECTED/);
  assert.match(server, /OWNER_CSRF_REJECTED/);
});


test('owner-session guard is evaluated before operational API dispatch', () => {
  const guard = server.indexOf('if (ownerAuth)');
  assert.ok(guard >= 0, 'owner-session guard must exist');
  for (const route of [
    "requestUrl.pathname === '/api/v1/tasks'",
    "requestUrl.pathname === '/executions'",
    "requestUrl.pathname === '/approvals/pending'",
    "requestUrl.pathname === '/agent'"
  ]) {
    const routeIndex = server.indexOf(route);
    assert.ok(routeIndex > guard, `${route} must be dispatched after the owner-session guard`);
  }
  const guardEnd = server.indexOf("if (req.method === 'POST' && requestUrl.pathname === '/api/v1/tasks')", guard);
  assert.ok(guardEnd > guard, 'operational routes must follow the shared guard');
  const guardBody = server.slice(guard, guardEnd);
  assert.match(guardBody, /if \(!ownerSession\)[\s\S]*OWNER_AUTH_REQUIRED[\s\S]*return;/);
});

test('execution status, event-stream, approval, cancel, and resume routes stay behind owner authentication', () => {
  const guard = server.indexOf('if (ownerAuth)');
  assert.ok(guard >= 0, 'owner-session guard must exist');
  const protectedRouteMarkers = [
    "const v1TaskPrefix = '/api/v1/tasks/'",
    "const executionEventsMatch =",
    "requestUrl.pathname === '/executions'",
    "requestUrl.pathname === '/approvals/pending'",
    "const executionStatusMatch =",
    "const executionApprovalsMatch =",
    "const executionCancelMatch =",
    "const executionResumeMatch =",
    "requestUrl.pathname === '/agent'"
  ];
  for (const marker of protectedRouteMarkers) {
    const routeIndex = server.indexOf(marker);
    assert.ok(routeIndex > guard, `protected route marker ${marker} must remain after owner authentication`);
  }
});

test('WebGL renderer degrades safely and bounds work on mobile devices', () => {
  const renderer = read('src/interfaces/http/command-scene.js');
  assert.match(renderer, /getContext\('webgl'/, 'renderer must use the supported WebGL fallback path');
  assert.match(renderer, /if \(!gl\) \{ useFallback\(\); return; \}/,
    'unavailable WebGL must switch to the CSS fallback');
  assert.match(renderer, /webglcontextlost/,
    'a context loss after initialization must stop rendering and reveal the fallback');
  assert.match(renderer, /eventNodes\.length > 6/,
    'the rendered execution graph must stay bounded to six event nodes');
  assert.match(renderer, /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.5\)/,
    'device pixel ratio must be capped to reduce mobile GPU cost');
  assert.match(renderer, /document\.hidden/,
    'animation must pause while the page is in the background');
  assert.match(renderer, /prefers-reduced-motion|matchMedia\('\(prefers-reduced-motion: reduce\)'\)/,
    'reduced-motion preference must be respected');
});
