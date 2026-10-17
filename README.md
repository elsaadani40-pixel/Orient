# ORIENT ONE

**A governed, local-first personal AI operating system — under active engineering.**

ORIENT is being built as one coherent system for researching, planning, executing, verifying, and recovering from work across phone, tablet, and computer. A canonical runtime owns task execution, tool permissions, durable state, approvals, and recovery. Client interfaces must not bypass those controls.

> **Status: pre-release / active development.** This repository does not claim that every planned capability is complete or production-ready. Use the source, tests, pull requests, and acceptance evidence to distinguish implemented behavior from roadmap.

## Start here

- **Repository:** [Source code](https://github.com/elsaadani40-pixel/Orient)
- **Brand website source:** [`website/index.html`](website/index.html) — responsive English/Arabic landing page with RTL support. This is source in the repository; it is not a claim that a public website deployment is live.
- **Engineering constitution:** [`AGENT.md`](AGENT.md)
- **Product contract and cross-device roadmap:** [`docs/product/ORIENT-PRODUCT-CONTRACT.md`](docs/product/ORIENT-PRODUCT-CONTRACT.md)
- **Cross-platform implementation and release gates:** [`docs/architecture/cross-platform-product-contract.md`](docs/architecture/cross-platform-product-contract.md)
- **Dashboard and control-plane contract:** [`docs/operations/DASHBOARD-CONTROL-PLANE.md`](docs/operations/DASHBOARD-CONTROL-PLANE.md)
- **Task workbench and manual smoke checklist:** [`docs/operations/TASK-WORKBENCH.md`](docs/operations/TASK-WORKBENCH.md)
- **Security policy:** [`SECURITY.md`](SECURITY.md)
- **Current threat model and tested boundaries:** [`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md)
- **Contribution rules:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Automated checks:** [GitHub Actions](https://github.com/elsaadani40-pixel/Orient/actions)

### Browser workbench and integration status

The unified website and canonical Runtime are integrated on `main`. Use `npm start` (or `npm run start:web`) to serve the landing page, public authentication, personal account, owner console, dashboard, memory interface, and task workbench from one local origin. The workbench submits tasks through the governed Runtime API; project audit, proposal, and owner-approved execution tools are registered in the server-side runtime.

- [Integrated website/Runtime session acceptance — PR #260](https://github.com/elsaadani40-pixel/Orient/pull/260) — merged after exact-head automated checks passed.
- [Integration/release gate — issue #225](https://github.com/elsaadani40-pixel/Orient/issues/225) — remains open for manual browser/device acceptance and deployment-readiness review.

**What this does not mean:** automated CI does not prove that owner login, approvals, resume/cancellation, and retry behavior have been manually verified on a phone, tablet, and desktop. No public deployment URL is claimed. Keep public hosting blocked until HTTPS, session persistence, operational controls, and the security boundary have been reviewed.

## Architecture principles

- **One canonical Runtime:** agents and clients do not bypass the runtime to perform privileged actions.
- **Governed capabilities:** tools declare permissions and risk; authorization is enforced at the execution boundary.
- **Human authority:** consequential actions require the appropriate durable owner approval.
- **Durable execution:** state, checkpoints, events, and recovery should survive process interruptions where the configured persistence adapter supports it.
- **Local-first by default:** local operation must be honest about unavailable network or integrations; no fabricated offline results.
- **Sandboxed project work:** audit, propose, execute, and verify are distinct operations; writes and commands remain bounded and governed.
- **Evidence-based reporting:** an accepted request or successful HTTP response is not, by itself, proof that the intended outcome occurred.
- **No uncontrolled self-modification:** project-building capabilities remain subject to explicit policy, scope, resource limits, and approval.

The product contract describes intended cross-device behavior and staged goals. It is a roadmap, not proof that every listed feature has shipped.

## Current engineering focus

- Canonical task lifecycle across the runtime and web clients.
- Tenant-scoped memory and execution history.
- Risk-based authorization and durable approvals.
- Checkpointing, idempotency, cancellation, and failure recovery.
- Bounded project workspace operations and post-change verification.
- Node.js unit/architecture tests, PostgreSQL integration tests, static safety checks, and Android companion build/tests.
- A browser acceptance path that can be exercised by the project owner.

CI results are commit-specific. A green run on an earlier commit does not make a later failing commit green, and automated tests do not replace real-device/browser acceptance or a security review.

## Requirements

- Node.js 22 or newer (the SQLite persistence adapter uses the built-in `node:sqlite` module)
- npm
- PostgreSQL only when using PostgreSQL persistence

## Quick start

```bash
git clone https://github.com/elsaadani40-pixel/Orient.git
cd Orient
npm ci
npm test
npm run check:syntax
```

### Run locally

Start the unified website + Runtime HTTP listener:

```bash
npm run start:web
```

This is equivalent to `node app.js`. By default, the server binds to `127.0.0.1:8080`. The `npm start` and `npm run start:web` commands both start the unified website + Runtime listener.

On first run, configure `ORIENT_OWNER_BOOTSTRAP_PASSWORD` with a strong password of at least 14 characters before starting the app; `ORIENT_OWNER_PASSWORD` is accepted as a compatibility alias. Example for a one-off local shell session: `export ORIENT_OWNER_BOOTSTRAP_PASSWORD='use-a-unique-strong-secret-here'` then `npm start`. Use a unique secret, keep shell history and environment access private, and never commit the value. ORIENT persists a password hash rather than the bootstrap plaintext and requires the owner to rotate the password on first sign-in.

- Open `http://127.0.0.1:8080/` for the ORIENT landing page.
- Open `http://127.0.0.1:8080/auth` for public account registration/sign-in.
- Open `http://127.0.0.1:8080/memory` for the local memory interface.
- Open `http://127.0.0.1:8080/dashboard` for the local execution dashboard and control plane.
- Open `http://127.0.0.1:8080/workbench` for the Arabic task workbench. Sign in to the owner console first; task creation, status, and events go through the canonical Runtime API. Choosing a preset only fills the form and never starts execution automatically.
- Open `http://127.0.0.1:8080/owner` for the authenticated Runtime owner console.
- For isolated website-only testing, `npm run start:website-standalone` runs `server.js` without Runtime task routes.

Owner-only routes require an authenticated owner session; the presence of a dashboard page is not authorization.

The dashboard exposes bounded, tenant-scoped execution history, per-execution event streams, pending approvals, and explicit cancellation requests. See [the dashboard contract](docs/operations/DASHBOARD-CONTROL-PLANE.md) for API details, security boundaries, and its smoke checklist.

To submit a task through the canonical agent runtime from another terminal:

```bash
curl -sS -X POST http://127.0.0.1:8080/agent \
  -H 'Content-Type: application/json' \
  -d '{"input":"احفظ أنني أختبر ORIENT"}'
```

Without a configured local model provider, the planner uses deterministic rules and requires no paid model API. When Ollama is configured, the planner can use schema-constrained local model planning with Runtime validation. This example uses the configured local persistence adapter. Inspect the returned status and verify the saved memory in the local interface; do not treat an HTTP response alone as proof that every tool or integration is available.

The default server binding is loopback-only. Do not expose it to a network without a complete authentication/session boundary and transport protection.

### Optional PostgreSQL persistence

Set `ORIENT_PERSISTENCE=postgres` and `ORIENT_DATABASE_URL` (or `DATABASE_URL`) in your local environment. Use a dedicated development/test database and least-privilege credentials. Never commit real connection strings or credentials.

A sample environment file is provided in [`.env.example`](.env.example). Copy it to `.env` locally; `.env` is ignored by Git.

## Repository map

- `src/core` — runtime, planning, execution, policies, authorization, and recovery
- `src/application` — application services and tool adapters
- `src/infrastructure` — persistence and external-system implementations
- `src/interfaces` — HTTP interfaces
- `test/unit` — unit and architecture tests
- `test/integration` — runtime, recovery, and persistence proofs
- `docs/architecture` — active architecture decisions, contracts, and ownership boundaries
- `docs/archive/architecture` — historical Phase 10–17 notes retained for traceability
- `docs/security` — security design notes and constraints
- `docs/product` — product contract and cross-device roadmap
- `website/` — static brand landing-page source
- `AGENT.md` — engineering constitution for coding agents

Archived implementations under `archive/` are historical reference material, not canonical runtime owners.

## Security and data handling

- Do not commit API keys, tokens, private keys, credentials, production database URLs, personal memories, customer data, or runtime state.
- Keep local runtime data under ignored paths and check `git status --short` before pushing.
- Do not put sensitive details in public issues or pull requests.
- Review [`SECURITY.md`](SECURITY.md) before using ORIENT with sensitive data.
- Public repository code, history, issues, and pull-request discussions may be visible and copied. Removing a file in a later commit does not erase it from Git history or other copies.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Keep changes focused, tested, documented, and reviewed. Do not merge a change with failing required checks or skip an unresolved dependency pull request.

## License

ORIENT is licensed under the [MIT License](LICENSE). The license applies to the repository's original code and documentation; third-party components remain subject to their own licenses. The `private: true` setting in `package.json` prevents accidental npm publication; it does not make this GitHub repository private.
