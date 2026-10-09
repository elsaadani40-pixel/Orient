'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLocalHttpHost } = require('../../../../src/core/config/local-bind-policy');

test('HTTP bind policy permits only explicit loopback addresses', () => {
  assert.equal(assertLocalHttpHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertLocalHttpHost('::1'), '::1');
  assert.equal(assertLocalHttpHost('LOCALHOST'), 'localhost');
});

test('HTTP bind policy fails closed for wildcard and remote addresses without authentication', () => {
  for (const host of ['0.0.0.0', '192.168.1.20', '10.0.0.2', '::', 'example.com', '']) {
    assert.throws(
      () => assertLocalHttpHost(host),
      error => error.code === 'UNSAFE_HTTP_BIND_HOST'
    );
  }
});
