'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function assertLocalHttpHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw Object.assign(
      new Error('ORIENT HTTP currently has no remote authentication boundary; HOST must be a loopback address (127.0.0.1, ::1, or localhost).'),
      { code: 'UNSAFE_HTTP_BIND_HOST' }
    );
  }
  return normalized;
}

module.exports = { assertLocalHttpHost, LOOPBACK_HOSTS };
