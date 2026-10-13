# ORIENT ONE

**A governed, local-first personal AI operating system — under active engineering.**

ORIENT is being built as one coherent system for researching, planning, executing, verifying, and recovering from work across phone, tablet, and computer. A canonical runtime owns task execution, tool permissions, durable state, approvals, and recovery. Client interfaces must not bypass those controls.

> **Status: pre-release / active development.** This repository does not claim that every planned capability is complete or production-ready. Use the source, tests, pull requests, and acceptance evidence to distinguish implemented behavior from roadmap.

## Start here

- **Repository:** [Source code](https://github.com/elsaadani40-pixel/Orient)
- **Brand website source:** [`website/index.html`](website/index.html) — responsive English/Arabic landing page with RTL support. This is source in the repository; it is not a claim that a public website deployment is live.
- **Engineering constitution:** [`AGENT.md`](AGENT.md)
- **Product contract and cross-device roadmap:** [`docs/product/ORIENT-PRODUCT-CONTRACT.md`](docs/product/ORIENT-PRODUCT-CONTRACT.md)
- **Dashboard and control-plane contract:** [`docs/operations/DASHBOARD-CONTROL-PLANE.md`](docs/operations/DASHBOARD-CONTROL-PLANE.md)
- **Security policy:** [`SECURITY.md`](SECURITY.md)
- **Contribution rules:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Automated checks:** [GitHub Actions](https://github.com/elsaadani40-pixel/Orient/actions)

### Browser workbench status

The responsive web task workbench and its governed project-builder integration are being developed in reviewable pull requests, not silently treated as released features:

- [Arabic web task workbench — PR #211](https://github.com/elsaadani40-pixel/Orient/pull/211)
- [Workbench to governed project builder — PR #221](https://github.com/elsaadani40-pixel/Orient/pull/221)

Both are drafts. The project-builder integration is stacked on PR #211. Do not merge it ahead of its dependency; complete the required CI, real-browser phone/tablet/desktop acceptance, approval/resume/cancellation checks, and deployment/security review first.

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

Start the HTTP application:

```bash
node app.js
```

By default, the server binds to `127.0.0.1:8080`.

- Open `http://127.0.0.1:8080` for the local memory interface.
- Open `http://127.0.0.1:8080/dashboard` for the local execution dashboard and control plane.

The dashboard exposes bounded, tenant-scoped execution history, per-execution event streams, pending approvals, and explicit cancellation requests. See [the dashboard contract](docs/operations/DASHBOARD-CONTROL-PLANE.md) for API details, security boundaries, and its smoke checklist.

To submit a task through the canonical agent runtime from another terminal:

```bash
curl -sS -X POST http://127.0.0.1:8080/agent \
  -H 'Content-Type: application/json' \
  -d '{"input":"احفظ أنني أختبر ORIENT"}'
```

The default planner is deterministic and does not require a paid model API. This example uses local JSON persistence. Inspect the returned status and verify the saved memory in the local interface; do not treat an HTTP response alone as proof that every tool or integration is available.

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
- `docs/architecture` — architecture decisions and ownership boundaries
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
