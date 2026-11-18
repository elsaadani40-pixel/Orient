'use strict';

const HARD_LINK_UNAVAILABLE_CODES = new Set(['EACCES', 'EPERM']);

/**
 * Creates a hard link for an adversarial filesystem test.
 *
 * Some supported filesystems/platform sandboxes prohibit hard-link creation
 * even for files owned by the current process. Only that explicit capability
 * denial is treated as a skipped hard-link scenario; every other error remains
 * a test failure.
 */
function createHardLinkOrSkip(t, fileSystem, source, destination) {
  try {
    fileSystem.linkSync(source, destination);
    return true;
  } catch (error) {
    if (!HARD_LINK_UNAVAILABLE_CODES.has(error?.code)) throw error;
    t.skip('Hard-link creation is denied by this filesystem policy (' + error.code + ')');
    return false;
  }
}

module.exports = createHardLinkOrSkip;
