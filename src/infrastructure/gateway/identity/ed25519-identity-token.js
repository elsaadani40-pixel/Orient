'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEADER = Object.freeze({ alg: 'EdDSA', typ: 'JWT' });
const CLAIM_KEYS = new Set([
  'iss', 'aud', 'sub', 'owner_id', 'tenant_id', 'workspace_id', 'session_id',
  'scope', 'iat', 'nbf', 'exp', 'jti', 'kid', 'challenge_id',
  'operation', 'operation_id', 'request_id'
]);

function fail(code) {
  throw Object.assign(new Error('Identity token rejected'), { code });
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(segment) {
  if (typeof segment !== 'string' || !BASE64URL.test(segment)) fail('IDENTITY_TOKEN_MALFORMED');
  try {
    const decoded = Buffer.from(segment, 'base64url');
    if (decoded.toString('base64url') !== segment) fail('IDENTITY_TOKEN_MALFORMED');
    const value = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('IDENTITY_TOKEN_MALFORMED');
    return value;
  } catch (error) {
    if (error.code === 'IDENTITY_TOKEN_MALFORMED') throw error;
    fail('IDENTITY_TOKEN_MALFORMED');
  }
}

function nonEmpty(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validateClaims(claims, { issuer, audience, nowSeconds, maxTtlSeconds, clockToleranceSeconds }) {
  if (Object.keys(claims).some(key => !CLAIM_KEYS.has(key))) {
    fail('IDENTITY_TOKEN_CLAIMS_REJECTED');
  }
  if (claims.iss !== issuer || claims.aud !== audience) fail('IDENTITY_TOKEN_AUDIENCE_REJECTED');
  if (!UUID.test(claims.owner_id || '') || claims.sub !== claims.owner_id ||
      !UUID.test(claims.session_id || '') ||
      !nonEmpty(claims.tenant_id, 128) || !nonEmpty(claims.workspace_id, 128)) {
    fail('IDENTITY_TOKEN_PRINCIPAL_INVALID');
  }
  if (!UUID.test(claims.jti || '') || !UUID.test(claims.challenge_id || '') ||
      !UUID.test(claims.operation_id || '') || !UUID.test(claims.request_id || '') ||
      !nonEmpty(claims.operation, 128)) {
    fail('IDENTITY_TOKEN_BINDING_INVALID');
  }
  if (!Array.isArray(claims.scope) || claims.scope.length < 1 || claims.scope.length > 32 ||
      claims.scope.some(scope => !nonEmpty(scope, 128)) ||
      new Set(claims.scope).size !== claims.scope.length) {
    fail('IDENTITY_TOKEN_SCOPE_INVALID');
  }
  if (![claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger) ||
      claims.iat > nowSeconds + clockToleranceSeconds ||
      claims.nbf > nowSeconds + clockToleranceSeconds ||
      claims.exp <= nowSeconds - clockToleranceSeconds ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > maxTtlSeconds) {
    fail('IDENTITY_TOKEN_TIME_INVALID');
  }
  return Object.freeze({
    iss: claims.iss,
    aud: claims.aud,
    sub: claims.sub,
    owner_id: claims.owner_id,
    tenant_id: claims.tenant_id,
    workspace_id: claims.workspace_id,
    session_id: claims.session_id,
    scope: Object.freeze([...claims.scope]),
    iat: claims.iat,
    nbf: claims.nbf,
    exp: claims.exp,
    jti: claims.jti,
    kid: claims.kid,
    challenge_id: claims.challenge_id,
    operation: claims.operation,
    operation_id: claims.operation_id,
    request_id: claims.request_id
  });
}

class Ed25519IdentityTokenIssuer {
  constructor({ privateKey, kid, issuer = 'orient-identity-authority', audience = 'orient-database-gateway', maxTtlSeconds = 60, now = () => Date.now() } = {}) {
    if (!privateKey || !nonEmpty(kid, 128) || !nonEmpty(issuer, 256) || !nonEmpty(audience, 256) ||
        !Number.isSafeInteger(maxTtlSeconds) || maxTtlSeconds < 1 || maxTtlSeconds > 60 ||
        typeof now !== 'function') throw new TypeError('Invalid identity token issuer configuration');
    this.privateKey = crypto.createPrivateKey(privateKey);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Identity signing key must be Ed25519');
    this.kid = kid;
    this.issuer = issuer;
    this.audience = audience;
    this.maxTtlSeconds = maxTtlSeconds;
    this.now = now;
  }

  issue({ principal, challengeId, operation, operationId, requestId, scope, ttlSeconds = 30 } = {}) {
    if (!principal || !UUID.test(principal.ownerId || '') ||
        principal.principalId !== principal.ownerId ||
        !UUID.test(principal.sessionId || '') ||
        !nonEmpty(principal.tenantId, 128) || !nonEmpty(principal.workspaceId, 128)) {
      fail('IDENTITY_TOKEN_PRINCIPAL_INVALID');
    }
    if (!UUID.test(challengeId || '') || !UUID.test(operationId || '') ||
        !UUID.test(requestId || '') || !nonEmpty(operation, 128)) {
      fail('IDENTITY_TOKEN_BINDING_INVALID');
    }
    if (!Array.isArray(scope) || scope.length < 1 || scope.length > 32 ||
        scope.some(item => !nonEmpty(item, 128)) || new Set(scope).size !== scope.length) {
      fail('IDENTITY_TOKEN_SCOPE_INVALID');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > this.maxTtlSeconds) {
      fail('IDENTITY_TOKEN_TTL_REJECTED');
    }

    const now = Math.floor(this.now() / 1000);
    const claims = {
      iss: this.issuer,
      aud: this.audience,
      sub: principal.ownerId,
      owner_id: principal.ownerId,
      tenant_id: principal.tenantId,
      workspace_id: principal.workspaceId,
      session_id: principal.sessionId,
      scope: [...new Set(scope)].sort(),
      iat: now,
      nbf: now,
      exp: now + ttlSeconds,
      jti: crypto.randomUUID(),
      kid: this.kid,
      challenge_id: challengeId,
      operation,
      operation_id: operationId,
      request_id: requestId
    };
    const signingInput = encode(HEADER) + '.' + encode(claims);
    const signature = crypto.sign(null, Buffer.from(signingInput), this.privateKey).toString('base64url');
    return signingInput + '.' + signature;
  }
}

class Ed25519IdentityTokenVerifier {
  constructor({ publicKeys, issuer = 'orient-identity-authority', audience = 'orient-database-gateway', maxTtlSeconds = 60, clockToleranceSeconds = 2, now = () => Date.now() } = {}) {
    if (!(publicKeys instanceof Map) || publicKeys.size < 1 ||
        !nonEmpty(issuer, 256) || !nonEmpty(audience, 256) ||
        !Number.isSafeInteger(maxTtlSeconds) || maxTtlSeconds < 1 || maxTtlSeconds > 60 ||
        !Number.isSafeInteger(clockToleranceSeconds) || clockToleranceSeconds < 0 || clockToleranceSeconds > 10 ||
        typeof now !== 'function') throw new TypeError('Invalid identity token verifier configuration');
    this.publicKeys = new Map();
    for (const [kid, key] of publicKeys) {
      if (!nonEmpty(kid, 128)) throw new TypeError('Invalid identity key id');
      const publicKey = crypto.createPublicKey(key);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Identity verification key must be Ed25519');
      this.publicKeys.set(kid, publicKey);
    }
    this.issuer = issuer;
    this.audience = audience;
    this.maxTtlSeconds = maxTtlSeconds;
    this.clockToleranceSeconds = clockToleranceSeconds;
    this.now = now;
  }

  verify(token, expected = {}) {
    if (typeof token !== 'string' || token.length > 8192) fail('IDENTITY_TOKEN_MALFORMED');
    const parts = token.split('.');
    if (parts.length !== 3 || !BASE64URL.test(parts[2])) fail('IDENTITY_TOKEN_MALFORMED');
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT' ||
        Object.keys(header).some(key => !['alg', 'typ', 'kid'].includes(key)) ||
        !nonEmpty(header.kid, 128) || claims.kid !== header.kid) {
      fail('IDENTITY_TOKEN_ALGORITHM_REJECTED');
    }
    const key = this.publicKeys.get(header.kid);
    if (!key) fail('IDENTITY_TOKEN_KEY_UNKNOWN');
    const signingInput = parts[0] + '.' + parts[1];
    let signature;
    try {
      signature = Buffer.from(parts[2], 'base64url');
      if (signature.toString('base64url') !== parts[2] || signature.length !== 64) {
        fail('IDENTITY_TOKEN_MALFORMED');
      }
    } catch (error) {
      if (error.code === 'IDENTITY_TOKEN_MALFORMED') throw error;
      fail('IDENTITY_TOKEN_MALFORMED');
    }
    if (!crypto.verify(null, Buffer.from(signingInput), key, signature)) fail('IDENTITY_TOKEN_SIGNATURE_INVALID');

    const verified = validateClaims(claims, {
      issuer: this.issuer,
      audience: this.audience,
      nowSeconds: Math.floor(this.now() / 1000),
      maxTtlSeconds: this.maxTtlSeconds,
      clockToleranceSeconds: this.clockToleranceSeconds
    });
    for (const field of ['challenge_id', 'operation', 'operation_id', 'request_id']) {
      if (expected[field] !== undefined && expected[field] !== verified[field]) {
        fail('IDENTITY_TOKEN_REQUEST_BINDING_MISMATCH');
      }
    }
    if (expected.requiredScope && !verified.scope.includes(expected.requiredScope)) {
      fail('IDENTITY_TOKEN_SCOPE_DENIED');
    }
    return verified;
  }
}

module.exports = { Ed25519IdentityTokenIssuer, Ed25519IdentityTokenVerifier };
