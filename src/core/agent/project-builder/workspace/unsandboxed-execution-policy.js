'use strict';

function isUnsandboxedExecutionEnabled({
  platform = process.platform,
  env = process.env
} = {}) {
  return ['darwin', 'win32'].includes(platform) &&
    env?.ORIENT_ALLOW_UNSANDBOXED === '1';
}

module.exports = { isUnsandboxedExecutionEnabled };
