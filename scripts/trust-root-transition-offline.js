'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readPrivateKeyFile
} = require('./sign-trust-manifest-offline');
const {
  readBoundedRegularFile
} = require('./verify-trust-manifest-offline');
const {
  signRootTransition,
  verifyRootTransition
} = require('../src/infrastructure/evidence/trusted-evidence-root-transition');

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const USAGE = [
  'Sign:',
  'node scripts/trust-root-transition-offline.js sign --payload <payload.json> --context <pinned-context.json> --next-root-key <next-root-private.pem> --output <signed-transition.json> [--current-root-key-id <id> --current-root-key <root-private.pem> | --recovery-signer <id>=<private.pem> ...]',
  'Verify:',
  'node scripts/trust-root-transition-offline.js verify --transition <signed-transition.json> --context <pinned-context.json> [--at <canonical-utc-time> | --historical]'
].join('\n');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function readJsonFile(filePath, codePrefix, maxBytes = MAX_INPUT_BYTES) {
  const bytes = readBoundedRegularFile(filePath, maxBytes, codePrefix);
  try {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(codePrefix + '_INVALID', 'Input must contain valid JSON');
    }
  } finally {
    bytes.fill(0);
  }
}

function writeCreateOnly(filePath, content) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    fail('TRUST_ROOT_TRANSITION_OUTPUT_REQUIRED', 'A transition output path is required');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
    fail('TRUST_ROOT_TRANSITION_OUTPUT_TOO_LARGE', 'Signed transition output exceeds 1 MiB');
  }
  const absolutePath = path.resolve(filePath);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(absolutePath, 'wx', 0o644);
    created = true;
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = undefined;
    }
    if (created) {
      try { fs.unlinkSync(absolutePath); } catch {}
    }
    if (error && error.code === 'EEXIST') {
      fail('TRUST_ROOT_TRANSITION_OUTPUT_EXISTS', 'Refusing to overwrite an existing signed transition');
    }
    fail('TRUST_ROOT_TRANSITION_OUTPUT_WRITE_FAILED', 'Unable to create signed transition output');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return absolutePath;
}

function loadContext(contextPath) {
  const context = readJsonFile(contextPath, 'TRUST_ROOT_TRANSITION_CONTEXT');
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      !context.expectedState || !context.trustedRootKeys || !context.recoveryPolicy ||
      !Number.isSafeInteger(context.clockSkewMs) ||
      !Number.isSafeInteger(context.maxValidityMs)) {
    fail('TRUST_ROOT_TRANSITION_CONTEXT_INVALID',
      'Context must contain pinned expectedState, trustedRootKeys, recoveryPolicy, clockSkewMs, and maxValidityMs');
  }
  return context;
}

function verificationOptions(context, verificationTime, historicalReplay = false) {
  return {
    expectedState: context.expectedState,
    trustedRootKeys: context.trustedRootKeys,
    recoveryPolicy: context.recoveryPolicy,
    verificationTime,
    clockSkewMs: context.clockSkewMs,
    maxValidityMs: context.maxValidityMs,
    historicalReplay
  };
}

function signTransitionFile({
  payloadPath,
  contextPath,
  nextRootKeyPath,
  outputPath,
  currentRootKeyId,
  currentRootKeyPath,
  recoverySignerSpecs = [],
  repoRoot = path.resolve(__dirname, '..'),
  platform = process.platform,
  now = () => new Date().toISOString()
} = {}) {
  const payload = readJsonFile(payloadPath, 'TRUST_ROOT_TRANSITION_PAYLOAD');
  const context = loadContext(contextPath);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !payload.payload && payload.schemaVersion !== 1) {
    // The signer accepts the transition payload itself, never an already signed envelope.
    if (!payload || payload.schemaVersion !== 1) {
      fail('TRUST_ROOT_TRANSITION_PAYLOAD_INVALID', 'A schemaVersion 1 transition payload is required');
    }
  }
  const mode = payload.mode;
  if (!['planned-rotation', 'emergency-recovery'].includes(mode)) {
    fail('TRUST_ROOT_TRANSITION_MODE_INVALID', 'Transition mode must be planned-rotation or emergency-recovery');
  }
  if (!Array.isArray(recoverySignerSpecs)) {
    fail('TRUST_ROOT_TRANSITION_SIGNER_INVALID', 'Recovery signer arguments must be an array');
  }
  if (mode === 'planned-rotation' &&
      (typeof currentRootKeyId !== 'string' || !currentRootKeyPath || recoverySignerSpecs.length !== 0)) {
    fail('TRUST_ROOT_TRANSITION_SIGNER_INVALID',
      'Planned rotation requires --current-root-key-id and --current-root-key, and forbids recovery signers');
  }
  if (mode === 'emergency-recovery' &&
      (currentRootKeyId !== undefined || currentRootKeyPath !== undefined || recoverySignerSpecs.length === 0)) {
    fail('TRUST_ROOT_TRANSITION_SIGNER_INVALID',
      'Emergency recovery requires recovery signers and forbids current-root private-key arguments');
  }

  const privateBuffers = [];
  try {
    const nextRootPrivateKey = readPrivateKeyFile(nextRootKeyPath, { repoRoot, platform });
    privateBuffers.push(nextRootPrivateKey);
    const recoverySigners = [];
    let currentRootPrivateKey;
    if (mode === 'planned-rotation') {
      currentRootPrivateKey = readPrivateKeyFile(currentRootKeyPath, { repoRoot, platform });
      privateBuffers.push(currentRootPrivateKey);
    } else {
      const seen = new Set();
      for (const spec of recoverySignerSpecs) {
        if (!spec || typeof spec.keyId !== 'string' || typeof spec.keyPath !== 'string' ||
            seen.has(spec.keyId)) {
          fail('TRUST_ROOT_TRANSITION_SIGNER_INVALID', 'Recovery signer IDs and paths must be valid and unique');
        }
        seen.add(spec.keyId);
        const privateKey = readPrivateKeyFile(spec.keyPath, { repoRoot, platform });
        privateBuffers.push(privateKey);
        recoverySigners.push({ keyId: spec.keyId, privateKey });
      }
    }

    const envelope = signRootTransition(payload, {
      currentRootKeyId,
      currentRootPrivateKey,
      nextRootPrivateKey,
      recoverySigners
    });

    const currentTime = now();
    const currentDate = new Date(currentTime);
    if (!Number.isFinite(currentDate.getTime()) || currentDate.toISOString() !== currentTime) {
      fail('TRUST_ROOT_TRANSITION_TIME_INVALID', 'Signer clock must return canonical UTC ISO-8601 time');
    }
    const effectiveAt = new Date(payload.effectiveAt);
    const nowMs = currentDate.getTime();
    const effectiveMs = effectiveAt.getTime();
    let verified;
    if (effectiveMs <= nowMs) {
      verified = verifyRootTransition(envelope,
        verificationOptions(context, currentTime, false));
    } else {
      if (Date.parse(payload.issuedAt) > nowMs + context.clockSkewMs ||
          Date.parse(payload.expiresAt) <= nowMs) {
        fail('TRUST_ROOT_TRANSITION_TIME_INVALID', 'A future-effective transition must already be issued and not expired');
      }
      verified = verifyRootTransition(envelope,
        verificationOptions(context, payload.effectiveAt, true));
    }
    if (!verified) {
      fail('TRUST_ROOT_TRANSITION_SELF_VERIFICATION_FAILED',
        'Signed transition did not verify against the pinned context and expected ledger state');
    }

    const writtenPath = writeCreateOnly(outputPath, JSON.stringify(envelope, null, 2) + '\n');
    return Object.freeze({
      outputPath: writtenPath,
      transitionSequence: verified.payload.transitionSequence,
      transitionDigest: verified.transitionDigest,
      mode: verified.payload.mode,
      nextRootKeyId: verified.nextRoot.keyId,
      verificationMode: effectiveMs <= nowMs
        ? 'current-transition-verification'
        : 'future-effective-transition-self-verification'
    });
  } finally {
    for (const bytes of privateBuffers) bytes.fill(0);
  }
}

function verifyTransitionFile({
  transitionPath,
  contextPath,
  verificationTime,
  historical = false,
  now = () => new Date().toISOString()
} = {}) {
  const envelope = readJsonFile(transitionPath, 'TRUST_ROOT_TRANSITION_INPUT');
  const context = loadContext(contextPath);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      !envelope.payload || typeof envelope.transitionDigest !== 'string') {
    fail('TRUST_ROOT_TRANSITION_INPUT_INVALID', 'A signed transition envelope is required');
  }
  if (historical !== true && verificationTime !== undefined && typeof verificationTime !== 'string') {
    fail('TRUST_ROOT_TRANSITION_TIME_INVALID', 'Verification time must be a canonical UTC timestamp');
  }
  const effectiveVerificationTime = historical
    ? envelope.payload.effectiveAt
    : verificationTime === undefined ? now() : verificationTime;
  const verified = verifyRootTransition(envelope, verificationOptions(
    context,
    effectiveVerificationTime,
    historical
  ));
  if (!verified) {
    fail('TRUST_ROOT_TRANSITION_REJECTED', historical
      ? 'Transition failed historical signature or chain verification'
      : 'Transition is not currently acceptable or failed signature, chain, or policy verification');
  }
  return Object.freeze({
    transitionSequence: verified.payload.transitionSequence,
    transitionDigest: verified.transitionDigest,
    mode: verified.payload.mode,
    previousRootKeyId: verified.payload.previousRootKeyId,
    nextRootKeyId: verified.nextRoot.keyId,
    issuedAt: verified.payload.issuedAt,
    effectiveAt: verified.payload.effectiveAt,
    expiresAt: verified.payload.expiresAt,
    verificationMode: historical ? 'historical-audit-only' : 'current-transition-verification',
    ...(historical ? {} : { verifiedAt: effectiveVerificationTime })
  });
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1) {
    fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
  }
  const [command, ...args] = argv;
  if (!['sign', 'verify'].includes(command)) {
    fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
  }
  const mapping = command === 'sign' ? {
    '--payload': 'payloadPath',
    '--context': 'contextPath',
    '--next-root-key': 'nextRootKeyPath',
    '--output': 'outputPath',
    '--current-root-key-id': 'currentRootKeyId',
    '--current-root-key': 'currentRootKeyPath'
  } : {
    '--transition': 'transitionPath',
    '--context': 'contextPath',
    '--at': 'verificationTime'
  };
  const options = { command, recoverySignerSpecs: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (command === 'sign' && flag === '--recovery-signer') {
      const value = args[index + 1];
      const separator = typeof value === 'string' ? value.indexOf('=') : -1;
      if (separator < 1 || separator === value.length - 1) {
        fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
      }
      options.recoverySignerSpecs.push({
        keyId: value.slice(0, separator),
        keyPath: value.slice(separator + 1)
      });
      index += 1;
      continue;
    }
    if (command === 'verify' && flag === '--historical') {
      if (options.historical === true || options.verificationTime !== undefined) {
        fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
      }
      options.historical = true;
      continue;
    }
    const property = mapping[flag];
    if (!property || Object.prototype.hasOwnProperty.call(options, property)) {
      fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
    }
    options[property] = value;
    index += 1;
  }
  if (command === 'sign') {
    for (const key of ['payloadPath', 'contextPath', 'nextRootKeyPath', 'outputPath']) {
      if (typeof options[key] !== 'string') fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
    }
  } else if (typeof options.transitionPath !== 'string' ||
      typeof options.contextPath !== 'string' ||
      (options.historical && options.verificationTime !== undefined)) {
    fail('TRUST_ROOT_TRANSITION_ARGUMENT_INVALID', USAGE);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const options = parseArgs(argv);
  if (options.command === 'sign') {
    const result = signTransitionFile(options);
    process.stdout.write('Signed root transition #' + result.transitionSequence +
      ' (' + result.mode + ', digest ' + result.transitionDigest +
      ') to ' + result.outputPath + '. Not uploaded or activated.\n');
  } else {
    const result = verifyTransitionFile(options);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write('Offline root-transition operation failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_INPUT_BYTES,
  MAX_PRIVATE_KEY_BYTES,
  MAX_OUTPUT_BYTES,
  readJsonFile,
  loadContext,
  signTransitionFile,
  verifyTransitionFile,
  parseArgs,
  main
};
