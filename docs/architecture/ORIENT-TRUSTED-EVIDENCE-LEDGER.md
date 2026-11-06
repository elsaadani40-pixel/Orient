# ORIENT Trusted Evidence Ledger — Design Contract

Status: proposed implementation contract  
Scope: PostgreSQL persistence on `feat/supabase-optional-cloud-architecture`  
Schema baseline reviewed: migration version 12  
Hosted Supabase: out of scope; no hosted project changes are authorized by this document.

## 1. Purpose and security boundary

The existing execution evidence record provides deterministic content identity, and checkpoint persistence verifies a snapshot digest during reads. Neither is an immutable audit ledger: the `orient_runtime` role currently has UPDATE and DELETE privileges on `checkpoints`, and a database administrator able to rewrite both data and its digest can defeat a database-local checksum.

The Trusted Evidence Ledger is a separate append-only application record stream. It must not repurpose checkpoints or make checkpoint retention depend on evidence retention.

The ledger is intended to provide:

- tenant-scoped, ordered evidence history per execution;
- cryptographic integrity for each record and its predecessor link;
- proof that a record was signed by a configured ORIENT evidence-signing key;
- runtime credentials that can append and read, but cannot update, delete, or truncate ledger rows;
- detection of truncation or complete chain replacement when compared with a trusted anchor held outside the database.

It does **not** prove that an observation is factually true. It proves that the configured signer attested to a particular evidence payload. A compromised ORIENT process with access to the signing key can create false new attestations. A database owner or superuser can bypass database-local controls. External anchors are required to detect rewriting or truncation by such privileged database actors.

## 2. Threat model

### In scope

- accidental or malicious UPDATE/DELETE attempts using the normal runtime login;
- cross-tenant reads or writes;
- concurrent writers trying to allocate the same execution sequence;
- replayed append requests;
- mutation of a payload, signature, hash, key identifier, or predecessor link;
- missing, reordered, or truncated rows when a previously trusted external anchor is available;
- normal key rotation while retaining verification of historical records.

### Explicitly not guaranteed

- protection against PostgreSQL superusers, database administrators, or the table-owning migration role rewriting database objects;
- protection against a compromised application process that can invoke the signer;
- truthfulness of the original tool output or observation;
- availability when PostgreSQL, the signing key provider, or the external anchor store is unavailable;
- non-repudiation against an operator who controls both the signing trust root and all external anchors.

No documentation or API may describe the ledger as tamper-proof without qualifying these boundaries.

## 3. Record model

Each append creates one immutable ledger envelope with these logical fields:

- `tenant_id`: trusted transaction principal tenant;
- `execution_id`: execution identifier from the validated evidence record;
- `sequence`: strictly increasing positive integer within (tenant, execution);
- `evidence_id`: existing `ev_<sha256>` content identity;
- `previous_hash`: prior record hash, or a documented genesis value for sequence 1;
- `record_hash`: SHA-256 of the canonical, domain-separated envelope excluding signature and record_hash;
- `key_id`: stable identifier for the signing public key;
- `signature`: Ed25519 signature over the domain-separated record hash;
- `record_payload`: the complete bounded evidence record, not the raw tool result;
- `recorded_at`: server-side insertion timestamp.

The canonical signed envelope must include tenant, execution, sequence, evidence identity, predecessor hash, key identifier, payload, and a normalized timestamp. Hashing and signing must use one documented canonical representation and an explicit domain separator such as `ORIENT-TRUSTED-EVIDENCE-V1\0`. Do not sign a loosely serialized JavaScript object or a database-generated JSON string.

The database representation must preserve the canonical payload semantics. Verification must recompute the canonical bytes from the returned payload and compare the resulting hash before checking the Ed25519 signature.

## 4. Append protocol

1. Require an active, validated `PostgresDatabase.withPrincipal()` context. Never accept tenant identity as an untrusted caller override.
2. Validate the evidence record with `verifyEvidenceRecord()`; reject an invalid identity, unsupported schema version, or execution mismatch.
3. Start or join the existing principal transaction. The ledger append and the corresponding execution/checkpoint state transition should commit atomically whenever they represent the same completed operation.
4. Acquire a transaction-scoped advisory lock derived from both tenant and execution identifiers. The lock key must use an unambiguous, collision-resistant derivation; do not concatenate values without length/domain separation.
5. Read the latest ledger row for that exact tenant and execution while holding the lock. Allocate sequence 1 with the genesis predecessor, or latest sequence + 1 with the latest record hash.
6. Enforce idempotency by (tenant_id, execution_id, evidence_id). If the same evidence identity already exists with the same canonical payload, return the existing record. If the identity exists with different content or a conflicting chain position, fail closed with a stable conflict error.
7. Build the canonical envelope, calculate its hash, and sign it with the configured Ed25519 signer selected by key_id. The private key must never be stored in PostgreSQL, source control, client bundles, or logs.
8. Insert exactly one row. The runtime role must not update an existing row to implement retries.
9. Commit the enclosing transaction. Any signing, verification, or insert failure must abort the append; never return an unsigned or partially persisted success.

The implementation must define and test how concurrent appends for different executions proceed independently and how same-execution writers serialize. Advisory lock collisions may serialize unrelated executions but must never permit duplicate sequence allocation.

## 5. PostgreSQL schema and privilege contract

Use a dedicated `execution_evidence` table; do not change the mutability contract of `checkpoints`.

Required database controls:

- primary key: (tenant_id, execution_id, sequence);
- unique constraint: (tenant_id, execution_id, evidence_id);
- non-null bounded fields for identifiers, hashes, key_id, signature, payload, and timestamp;
- row-level security enabled and forced where compatible with the owner/migration lifecycle;
- tenant policy using the same trusted transaction-local tenant context as other runtime tables;
- no grants to PUBLIC, `anon`, or `authenticated`;
- `orient_runtime`: SELECT and INSERT only;
- explicitly revoke UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER from runtime and public-facing roles;
- no runtime ownership of the table, sequence, trigger function, or schema;
- include the table in the role-provisioning ownership inventory so `orient_owner` owns it after provisioning;
- add database triggers that reject UPDATE, DELETE, and TRUNCATE as defense in depth against accidental privileged application paths.

The trigger is not a security boundary against the table owner or a superuser: those roles can disable or replace it. The privilege test must inspect effective privileges of `orient_runtime_login`, not only the group role.

Migration must be a new explicit schema migration (version 13 or the next available version after rechecking the branch). PostgreSQL startup remains read-only. The migration must be transactional and idempotent under the existing migration runner and advisory migration lock.

## 6. Signing keys and rotation

- Use Ed25519 keys and stable, non-secret `key_id` values.
- Keep private keys outside PostgreSQL and outside the repository. Do not generate ephemeral signing keys during application startup.
- Key provisioning and rotation are explicit administrative operations, never implicit startup behavior.
- Verification uses a trusted public-key manifest/configuration with validity and revocation metadata. A public key copied only from the same database row being verified is not a trust source.
- Historical records remain verifiable after rotation; removing a key from the active signing set must not erase its public verification material.
- A new key must be authorized by a separately trusted root or by an authenticated rotation statement chained to an already trusted key.
- Tests must cover unknown key IDs, invalid signatures, key rotation, historical verification, revoked signing keys, and a failed signer.

A local file-backed key provider may be used for the first local-first implementation if file permissions and lifecycle are checked fail-closed. A provider interface must allow a hardware-backed or external signer later without changing the ledger protocol. The implementation must state clearly that a process able to read the private key can sign records.

## 7. External anchoring

A database-local hash chain cannot detect an attacker who rewrites the complete chain and recomputes every hash and signature using a compromised signing key, nor can it independently prove that the latest rows were not deleted by a privileged database actor.

Periodically produce a signed anchor containing at least:

- tenant_id and execution_id;
- highest anchored sequence;
- corresponding record_hash;
- key_id and anchor creation time;
- a signature over a domain-separated canonical anchor envelope.

Persist the anchor outside the PostgreSQL trust domain (for example, owner-controlled offline export or an independently administered append-only store). The verification API must distinguish:

- chain valid up to current database head;
- chain valid and matches a trusted external anchor;
- chain valid but not externally anchored;
- chain invalid or shorter than a known anchor.

Do not report an unanchored chain as protected against privileged database rewriting. The first implementation may expose explicit export/import/verification primitives; it must not silently claim that writing an anchor into another table in the same database provides independent protection.

## 8. Verification contract

Provide verification for a complete execution chain and for a bounded range where the predecessor is known. Verify, in order:

1. tenant and execution scope;
2. contiguous sequence starting from the defined genesis;
3. predecessor hash equality;
4. canonical payload and evidence identity validity;
5. record hash recomputation;
6. key_id resolution from trusted key material;
7. Ed25519 signature validity;
8. highest sequence and hash against an optional trusted external anchor.

Return structured status and stable error codes. Never silently skip an invalid row, unknown key, missing predecessor, or gap. Partial verification must explicitly report the verified range and its unverified boundary.

## 9. Required test matrix

### Unit tests

- canonical envelope determinism independent of object key order;
- domain separation and version separation;
- invalid evidence record rejected;
- valid and invalid Ed25519 signatures;
- modified payload, tenant, execution, sequence, predecessor, key_id, or timestamp rejected;
- unknown key and invalid key material rejected;
- signer failure leaves no success result;
- rotation preserves verification of historical records;
- revoked key policy is explicit and tested;
- anchor signatures and anchor mismatch handling.

### Real PostgreSQL integration tests

- migration from schema 12 to the new schema on PostgreSQL 17;
- runtime login can SELECT and INSERT but cannot UPDATE, DELETE, or TRUNCATE;
- runtime cannot disable triggers, alter table ownership, or create objects in public schema;
- RLS prevents cross-tenant SELECT and INSERT;
- same-execution concurrent appends produce unique contiguous sequences and a valid predecessor chain;
- different tenants using the same execution identifier remain isolated;
- idempotent retry returns the original row without adding a second sequence;
- conflicting duplicate evidence fails closed;
- UPDATE, DELETE, and TRUNCATE are rejected;
- tampered payload/hash/signature/predecessor is detected by verification;
- deletion or truncation is detected when compared with an external anchor;
- key rotation and historical verification work across process/repository restart;
- transaction rollback leaves neither an orphan ledger row nor a committed associated checkpoint;
- pooled connection role and transaction-local tenant context are reset after success and failure.

All cleanup paths must be deterministic and must not swallow cleanup failures.

## 10. Delivery gates

Do not begin ToolSpec, Unified Tool Gateway expansion, or `execution.list` until this ledger milestone is implemented and verified.

The milestone is complete only when:

- the schema and role grants meet the contract;
- the append and verification APIs are integrated with the execution lifecycle;
- unit and real PostgreSQL tests cover the matrix above;
- Node 22/24 suites, full repository suite, Android, Browser Acceptance, CodeQL, Secret Scanning, and required CI checks pass on the exact same branch head;
- the PR remains Draft unless the owner explicitly requests otherwise;
- no hosted Supabase project has been mutated.

## 11. Current audit observations

At the reviewed schema version 12:

- `checkpoints` is tenant-scoped by RLS but runtime has SELECT, INSERT, UPDATE, and DELETE grants;
- `PostgresCheckpointRepository.save()` allocates sequence under a transaction-scoped advisory lock, but this is checkpoint ordering, not an immutable evidence protocol;
- `findLatest()` validates a SHA-256 digest, which detects payload edits that do not also replace the digest;
- `PostgresDatabase.withPrincipal()` installs tenant/owner/session settings transaction-locally and reuses the active client through AsyncLocalStorage;
- `PostgresDatabase.transaction()` creates a savepoint when called within a principal transaction and a standalone transaction otherwise;
- role provisioning assigns application table ownership to `orient_owner`, while runtime is a non-login group role inherited by `orient_runtime_login`;
- the current evidence record is content-addressed and stores a digest of the result, not the raw result, but it is not yet persisted in a separate signed ledger.

These observations are based on branch source at the time this contract was written and must be rechecked before implementation if the branch head changes.

## 12. Implementation status — branch work in progress

The first implementation slice has been added on `feat/supabase-optional-cloud-architecture`:

- Migration 13 creates `execution_evidence` with tenant/execution/sequence primary key, evidence uniqueness, bounded identifiers, hash/signature checks, RLS, and an append-only mutation trigger.
- The migration explicitly revokes all runtime table grants before granting only SELECT and INSERT.
- `scripts/provision-postgres-roles.js` includes the ledger in the owner-role table inventory.
- `trusted-evidence-cryptography.js` signs record envelopes and external anchors with Ed25519 using distinct domain separators. Verification uses separately configured trusted public-key maps and validity/revocation timestamps.
- `PostgresExecutionEvidenceRepository` validates the complete existing chain under an execution-scoped advisory transaction lock before each append; same-evidence retries return the existing verified envelope; concurrent appends allocate contiguous sequence numbers.
- `createAnchorPayload()` exports an unsigned anchor request after verifying the database chain. A separately operated owner/offline signer must sign it with an Ed25519 private key that is never loaded into the Runtime process; the signed anchor must then be persisted outside the PostgreSQL trust domain.
- `verifyExecution()` distinguishes unanchored chains, anchored prefixes, and fully head-anchored chains. Appends can accept a previously exported anchor and fail closed if the persisted chain no longer reaches it.
- Evidence signing is explicit Runtime configuration. Anchor signing is intentionally not configured in the Runtime repository: the anchor private key belongs to a separately operated signer. No ephemeral keypair is generated and no private key is persisted in the database or source tree.

### Current implementation limits

- `ExternalEvidenceAnchorStore` now provides a backend-neutral append/get/list adapter for signed anchors. It verifies signatures before persistence, uses tenant/execution-scoped immutable object keys, performs conditional create-only writes, makes exact retries idempotent, rejects conflicting sequence reuse, and verifies scope/signatures/canonical bytes on read and list.
- The storage backend contract requires strongly consistent `putIfAbsent`, `get`, and `list`. The backend principal must be unable to overwrite or delete objects; retention/object-lock and backup/restore must be configured and independently administered by the operator. The adapter deliberately has no update/delete method.
- Unit tests use an in-memory immutable backend to validate generic adapter semantics and a fake S3 client to validate the AWS S3 Object Lock command contract. They do not prove real AWS account configuration, durability, retention enforcement, backup recovery, or independent trust-domain separation.
- `S3ObjectLockEvidenceAnchorBackend` is an optional provider adapter that accepts an AWS SDK for JavaScript v3 S3 client and command constructors by dependency injection; the core package does not add an AWS SDK dependency. It uses conditional `PutObject` (`IfNoneMatch: "*"`), applies COMPLIANCE Object Lock retention at creation, reads objects, and paginates listings. It intentionally exposes no overwrite or delete operation.
- The S3 adapter now retries HTTP 409 `ConditionalRequestConflict` responses with a bounded, linearly increasing delay (three retries by default); HTTP 412 still triggers a read-back to implement exact idempotent retry semantics. Retry count, delay, and sleep function are injectable and validated.
- S3 listing fails closed when the provider omits or returns a non-boolean `IsTruncated` pagination flag; this prevents malformed responses from being mistaken for a complete listing and silently hiding later anchor pages.
- S3 listing now reads object bodies through a bounded worker pool (eight concurrent reads by default), preserving listing order without launching an unbounded `Promise.all` across the entire key set. The concurrency limit is configurable and validated.
- S3 object reads enforce a configurable maximum body size (1 MiB by default). Streaming bodies are counted incrementally before buffering; buffered SDK conversion requires a valid `ContentLength`, then measures the UTF-8 byte length of the returned string and rejects both oversized content and any declared/observed length mismatch. Oversized or unverifiable buffered responses fail closed.
- Production use requires a dedicated bucket with S3 Object Lock enabled at bucket creation, versioning enabled, a separately administered bucket policy denying delete and retention-bypass permissions to the adapter principal, a documented retention period, and an independently administered backup/restore procedure. The operator must verify these controls in the actual AWS account; passing fake-client tests is not evidence that the bucket enforces them.
- A real-provider integration test and operational evidence (bucket configuration, effective IAM policy, retention verification, recovery drill, and independent administrator boundary) remain outstanding. Until then this adapter is an implemented integration boundary, not a production deployment claim.
- The first append implementation verifies the full execution chain before every write, which is intentionally conservative and O(n) per append. A later optimization must preserve verification against a trusted external anchor and must not silently trust an unverified database-local head.
- Evidence signing keys and anchor signing keys are supplied by the host application. Key custody and operational rotation remain explicit host responsibilities.
- `trusted-evidence-trust-manifest.js` defines a root-signed Ed25519 trust manifest with a canonical payload, explicit schema/version, issuance timestamp, and the evidence public-key set with validity/revocation metadata. The root public key must be pinned through out-of-band trusted configuration; a root key delivered only inside the manifest is never trusted.
- Current trust-manifest acceptance requires a signed canonical `expiresAt` timestamp later than `issuedAt`, with a maximum validity interval of 90 days. Acceptance rejects expired manifests and manifests issued more than five minutes in the future. Historical verification intentionally evaluates a manifest at its own issuance time and remains available after expiry for audit; historical verification does not authorize a new trust-state update.
- Root-key `validFrom` and `revokedAt` metadata is enforced against both the signed manifest `issuedAt` and the verification purpose/time. Historical verification defaults to the manifest issuance instant, preserving audit of a manifest signed before a later revocation. Trust-state acceptance supplies the current verification time and rejects a delayed pre-revocation manifest after the root has been revoked. Emergency compromise handling still requires an explicit policy for invalidating previously accepted trust state and re-anchoring the manifest version.
- `verifyAndAcceptTrustManifest()` verifies the root signature and enforces monotonically increasing manifest versions through an injected durable `versionStore` contract. The store must provide atomic compare-and-set, retain the highest accepted version and manifest digest, and be independently protected from rollback by the Runtime identity. Exact same-version/same-digest retries are idempotent; lower versions, same-version content changes, malformed persisted state, and concurrent CAS races fail closed.
- Unit tests cover root signature verification, payload tampering, unknown roots, malformed signatures, invalid keys/timestamps, monotonic acceptance, rollback, same-version conflict, idempotent retry, malformed state, and CAS races.
- `TrustManifestAcceptanceService` provides a transport-neutral acceptance boundary. It requires a host-provided authenticated-principal authorizer, checks the `trust-manifest.accept` action, bounds canonical manifest size, verifies the pinned root signature, and returns only the accepted version and digest. Authorization failure is closed by default. This is a service core, not a deployed network daemon: mTLS/session authentication, process isolation, secret delivery, rate limiting, and operational deployment remain host responsibilities.
- `PostgresTrustManifestVersionStore` now implements durable PostgreSQL `read()` and atomic compare-and-set. The adapter uses a singleton row, an expected-version + expected-digest predicate, and a strictly increasing version condition. The accompanying `scripts/provision-trust-manifest-store.sql` creates a monotonic-update guard and rejects DELETE/TRUNCATE for the runtime role. Unit tests cover query predicates and invalid states; a real PostgreSQL integration test covers concurrent writers and persistence across a new pool instance.\n- The PostgreSQL adapter is safe only when its database and credentials are administered in a separate trust domain. Do not point it at the ordinary ORIENT application database or give its credential to the Runtime process: a compromised Runtime with direct UPDATE access could advance the version to an arbitrary value (denial of service) or replace the digest. Deploy it behind a separately operated trust-store service that verifies signed manifests before invoking CAS. Database administrators remain outside the monotonicity guarantee.\n- This is still not a complete production trust deployment: the separately operated trust-store service, offline root ceremony, root rotation/recovery procedure, and authenticated root-key distribution have not been integrated. An operator able to roll back both the manifest and its supposedly independent version store can defeat rollback detection; production must place monotonic state in a separately controlled durable trust domain.
- No hosted Supabase project has been changed. Migration 13 is only code in the branch until an explicitly authorized deployment runs it.

These are implementation boundaries, not completed production guarantees. The ledger milestone remains open until real PostgreSQL 17 integration, key lifecycle tests, external anchor persistence/restore, full CI, and a reviewed deployment procedure are complete.


### PostgreSQL monotonic trust-state adapter

The first durable adapter is implemented in `src/infrastructure/evidence/postgres-trust-manifest-version-store.js`.

- `read()` reads the single active manifest version and digest.
- Initial acceptance uses a conditional INSERT with `ON CONFLICT DO NOTHING`.
- Updates compare both the expected version and expected digest in one SQL statement and require the new version to be greater than the stored version. Concurrent writers based on the same state cannot both win.
- `scripts/provision-trust-manifest-store.sql` is a separate bootstrap script. It must be run by a trust-store database administrator after creating the dedicated `orient_trust_manifest_runtime` role. It installs update/delete/truncate guards and grants only SELECT, INSERT, and UPDATE.
- The integration test creates an isolated schema, races two writers, and verifies the accepted state through a newly created pool.

**Critical deployment boundary:** this adapter is not a reason to store monotonic state in the same application database. It must be called by a separately operated trust-store service with its own database and credentials. Do not give those credentials to ORIENT Runtime. A direct Runtime credential could advance the version to an arbitrary value and cause denial of service, even though the SQL guard prevents rollback. The service must verify the root signature before allowing a state transition. PostgreSQL superusers/database administrators can still rewrite the trust store and are outside this guarantee.


### Trust manifest acceptance service boundary

`src/infrastructure/evidence/trust-manifest-acceptance-service.js` implements the transport-neutral trust update operation. The host must authenticate the caller and provide a principal authorizer; the service itself does not accept a bearer token or trust caller-supplied role text. The authorizer must derive privileges from an authenticated identity outside ORIENT Runtime. The service verifies the root signature before advancing the separately administered monotonic store, limits canonical manifest size, and returns only `{ version, digest, accepted }`.

This module is not yet a separately deployed service process or HTTP endpoint. Production deployment still requires an independently operated host, authenticated transport (for example mTLS), independent database credentials, secret management, rate limiting, monitoring, and recovery procedures. Do not expose the service directly to untrusted network clients without that host layer.
