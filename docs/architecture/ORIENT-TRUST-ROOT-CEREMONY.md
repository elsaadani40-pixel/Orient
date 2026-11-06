# ORIENT Trust Root Ceremony and Offline Signing

## Status and security boundary

This document defines the operator procedure for bootstrapping and rotating trust roots. The current implementation has a root-signed v2 trust manifest, pinned root public keys, expiry and revocation checks, a monotonic PostgreSQL cache, and an independently anchored manifest history.

The offline signing utility is:

`scripts/sign-trust-manifest-offline.js`

It signs a manifest payload and verifies the resulting signature locally. It does not generate root keys, contact a server, deploy trust state, write to PostgreSQL, or append to the external immutable history. Root-key distribution and root rotation remain explicit out-of-band operator procedures; they are not automatically negotiated by the Runtime.

## Roles and separation of duties

Use separate people or independently controlled roles for:

1. **Root custodian:** controls the offline root private key and performs signing.
2. **Trust reviewer:** independently verifies the manifest contents, key fingerprints, validity window, version, and change approval.
3. **Runtime deployer:** installs the pinned root public-key configuration and trust manifest acceptance service configuration.
4. **Trust-store administrator:** controls the external immutable history and its credentials, separately from the application database and Runtime.

At least two people must approve a new root, a root rotation, or emergency recovery. The Runtime must never receive an offline root private key. Do not place private keys in the repository, CI variables, application environment files, PostgreSQL, S3, or the Runtime host.

## Bootstrap

### 1. Generate the root key offline

On a dedicated offline machine, generate an Ed25519 key pair with a trusted cryptographic tool. For example, with OpenSSL:

```sh
umask 077
openssl genpkey -algorithm ED25519 -out offline-root-private.pem
chmod 600 offline-root-private.pem
openssl pkey -in offline-root-private.pem -pubout -out offline-root-public.pem
```

Keep the private key on encrypted offline media or an approved hardware-backed key store. Maintain a separately protected recovery copy. Never copy the private key into the repository or onto the Runtime machine.

### 2. Pin and verify the public key

Assign a stable, unique key ID. Compute the public-key fingerprint:

```sh
openssl pkey -pubin -in offline-root-public.pem -outform DER | openssl dgst -sha256
```

Have the reviewer verify the fingerprint through an independent channel. Install the public key and key ID in the host's pinned `trustedRootKeys` configuration. A public key supplied only inside a manifest is never trusted.

### 3. Prepare and sign the first v2 manifest

Prepare a JSON payload containing:

- a positive, monotonically increasing manifest version (bootstrap uses version 1);
- canonical UTC `issuedAt` and `expiresAt` timestamps;
- an expiry later than issuance and no more than 90 days after issuance;
- the public evidence-signing keys and their validity metadata.

Review the exact payload and evidence-key fingerprints before signing. Then run the offline signer:

```sh
node scripts/sign-trust-manifest-offline.js \
  --input manifest.payload.json \
  --key /secure/offline/offline-root-private.pem \
  --root-key-id offline-root-2026 \
  --output signed-manifest-v1.json
```

The signer requires the private-key file to be outside the repository, rejects symlinks, requires owner-only POSIX permissions, enforces bounded input/output sizes, refuses to overwrite an existing output, and verifies the signature and current validity window before writing. The command accepts a **path**, never private-key material as an argument. It does not upload or activate the manifest.

### 4. Independently verify and anchor

On a separate clean machine, verify the signed manifest using the independently pinned root public key. Confirm the version, root key ID, signature, digest, issuance and expiry times, and evidence-key set against the approval record.

Only then submit it to the separately operated TrustManifestAcceptanceService. Acceptance must verify authorization, signature, current root validity, expiry, monotonic version state, and the complete external immutable history. The external history append happens before the PostgreSQL cache update. Preserve the external anchor receipt and accepted digest with the audit record.

The first manifest is not trusted merely because the signer created it. The initial public-key pin and the first external anchor are separate bootstrap controls.

## Evidence signing-key rotation

Evidence signing keys are distinct from trust root keys.

1. Generate a new Ed25519 evidence key in the approved signing environment.
2. Add its public key to the next manifest version with a deliberate `validFrom` time.
3. Keep the prior public key available for historical evidence verification. Do not remove it merely because a new key is active.
4. If a key is compromised, set its signed `revokedAt` time and issue the next manifest promptly. Acceptance evaluates revocation at the current verification time; historical verification remains possible for audit.
5. Sign offline, independently review, anchor the next contiguous version, and verify the local cache.
6. Retire the old private key only after the evidence retention and recovery requirements have been reviewed.

Do not backdate a replacement key or silently rewrite an already accepted manifest version.

## Trust root rotation

The trust root is a higher-level pin and is not rotated by editing the evidence-key list in a trust manifest.

A planned root rotation requires an explicit, reviewed software/configuration release:

1. Generate the new root key offline and independently verify its public fingerprint.
2. Add the new root public key under a new key ID to the pinned `trustedRootKeys` configuration through the approved deployment process.
3. During a controlled overlap, retain the old root only for the explicitly approved transition window. Use the new root key ID for the next trust manifest after the new pin is deployed.
4. Confirm the new-root-signed manifest is accepted and externally anchored.
5. Set the old root's `revokedAt` in the pinned configuration and deploy that revocation. Verify that current acceptance rejects the old root while historical verification of manifests issued before revocation remains possible.
6. Record both fingerprints, the approval identities, configuration release, manifest version/digest, external anchor receipt, and effective revocation time.

This transition is intentionally out-of-band today: the current manifest format does not carry or automatically install a new trusted root key set. A signed in-band root-key transition protocol, dual signatures, and automated root-key distribution are not implemented. Do not claim automated root rotation.

## Emergency root compromise

If an offline root private key is suspected compromised:

- stop accepting trust updates signed by that root;
- do not rely on the compromised key to authorize its own replacement;
- use a separately pinned recovery root, if one was established and independently protected, to authorize a new pinned-root configuration release;
- otherwise perform an out-of-band trust re-bootstrap through independently verified public-key fingerprints and a reviewed deployment release;
- preserve the previous external manifest history for forensic audit, but do not reactivate revoked evidence keys;
- issue a new manifest version and anchor it in the independent trust history;
- document the incident, affected key IDs, time window, evidence scope, recovery approvals, and new trust head.

If no independent recovery root or trustworthy distribution channel was established before compromise, there is no cryptographic shortcut. Recovery requires an explicit operator trust reset. Never accept a replacement root solely because it was signed by the compromised root.

## Recovery and rollback controls

The external immutable manifest history is authoritative; the PostgreSQL version row is a recoverable cache. The authorized `recover()` operation may rebuild the cache pointer from the verified external head. It does not reactivate expired evidence keys or accept a new manifest.

- If the cache is behind the external head, recover from the verified external history.
- If the cache is ahead of the external head, or the digests conflict, stop and require operator investigation.
- If the external history is missing, incomplete, or has a conflicting immutable version, do not fall back to PostgreSQL alone.
- Keep the external store's administrative identity, retention policy, and recovery backups separate from Runtime and the application database.

## Audit record and release gate

For every bootstrap, evidence-key rotation, root rotation, or emergency recovery, preserve:

- change ticket and two-person approvals;
- root and evidence key IDs and public fingerprints (never private key bytes);
- manifest version, canonical digest, issuance and expiry timestamps;
- exact signed manifest artifact and external anchor receipt;
- pinned-root configuration release and deployed commit SHA;
- verification and recovery test results;
- operator identity and UTC timestamps.

The offline signer and this procedure do not establish a production trust guarantee by themselves. Real-provider Object Lock, IAM boundaries, external-store recovery, root-key custody, and independent operational review must be demonstrated before production claims are made. No hosted Supabase project or AWS resource is changed by this procedure.
