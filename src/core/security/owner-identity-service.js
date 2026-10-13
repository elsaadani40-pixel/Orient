'use strict';

// Canonical owner identity lifecycle shared by website and Runtime adapters.
// Keep public-user authentication separate from this owner-only authority.
class OwnerIdentityService {
  constructor() {
    throw new Error('OwnerIdentityService implementation is not yet wired; do not use as an auth provider');
  }
}

module.exports = OwnerIdentityService;
