# ORIENT

**A governed personal AI operating system — under active development.**

ORIENT is being engineered around a canonical runtime that coordinates planning, agent invocation, capability authorization, tool execution, durable state, observability, and recovery. The product direction is one coherent experience across phone, tablet, and computer—not a collection of unrelated demos. It prioritizes local-first operation, explicit permissions, human approval for consequential actions, and verifiable outcomes.

## Product direction

ORIENT is intended to be one coherent personal AI operating system across Android phones, tablets, and computers—not a collection of device-specific demos. Its cross-device product contract, canonical task lifecycle, research-to-plan-to-verify workflow, learning model, security boundaries, and staged roadmap are documented in [the ORIENT Product Contract](docs/product/ORIENT-PRODUCT-CONTRACT.md). This is a target contract, not a claim that every listed capability is already implemented.

## Brand website

The premium responsive brand experience is in [`website/index.html`](website/index.html). It includes responsive layouts, English/Arabic language switching with RTL support, an animated dimensional visual, reduced-motion accessibility support, platform principles, and links to the source repository.

The website is a product/brand landing page. It does **not** imply that every product capability shown as a direction is already released. Current implementation status must be established from code, tests, and release evidence.

## Project status

ORIENT is in active engineering / pre-release. This repository is not a claim that every planned capability is production-ready. Read the source, tests, and architecture notes to distinguish implemented behavior from future work.

## Current engineering focus

- A canonical runtime and governed tool/capability execution path.
- Tenant/scope-aware memory and durable execution state.
- Risk-based authorization and human approval for high-risk operations.
- Checkpointing, idempotency, cancellation, and failure recovery.
- Sandboxed project operations with explicit resource limits.
- Automated tests across supported Node.js versions and PostgreSQL integration.
- A unified task/capability contract for clients across supported devices.

The test suite is evidence for the scenarios it covers; it is not a blanket security certification or a guarantee against every failure mode.

## Requirements

- Node.js 20 or newer
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

### Run a first local task

Start the HTTP application:

```bash
node app.js
```

Open `http://127.0.0.1:8080` for the local memory interface or `http://127.0.0.1:8080/dashboard` for the local control plane. The dashboard exposes tenant-scoped execution history, per-execution SSE events, a bounded event-driven WebGL view, pending approvals, and explicit cancellation requests. See [`docs/operations/DASHBOARD-CONTROL-PLANE.md`](docs/operations/DASHBOARD-CONTROL-PLANE.md) for the exact API contract, safety boundaries, and smoke checklist. To submit a task to the canonical agent runtime from another terminal:

```bash
curl -sS -X POST http://127.0.0.1:8080/agent \
  -H 'Content-Type: application/json' \
  -d '{"input":"احفظ أنني أختبر ORIENT"}'
```

The default planner is deterministic and does not require a paid model API. The example uses local JSON persistence. Check the returned execution status and verify the saved memory in the local interface; do not treat an HTTP response alone as proof that every future tool or integration is available.

The default configuration uses local JSON persistence and binds the HTTP server to `127.0.0.1:8080`. Review `src/core/config/index.js` and the security documentation before exposing any service to a network.

### Optional PostgreSQL persistence

Set `ORIENT_PERSISTENCE=postgres` and `ORIENT_DATABASE_URL` (or `DATABASE_URL`) in your local environment. Never commit real connection strings or credentials. Use a dedicated development/test database and least-privilege credentials.

A sample environment file is provided in [`.env.example`](.env.example). Copy it to `.env` for local use; `.env` is ignored by Git.

## Repository map

- `src/core` — runtime, policies, planning, execution, and governance
- `src/application` — application services and tool adapters
- `src/infrastructure` — persistence and external-system implementations
- `src/interfaces` — HTTP interfaces
- `test/unit` — unit and architecture tests
- `test/integration` — runtime recovery and persistence proofs
- `docs/architecture` — architecture decisions and ownership boundaries
- `docs/security` — security design notes and constraints
- `AGENT.md` — engineering constitution for coding agents

Archived implementations under `archive/` are historical reference material, not canonical runtime owners.

## Security and data handling

- Do not commit API keys, tokens, private keys, credentials, production database URLs, personal memories, customer data, or runtime state.
- Keep local runtime data under ignored paths; verify `git status --short` before every push.
- Do not put sensitive details in public issues or pull requests.
- Review [`SECURITY.md`](SECURITY.md) before using the project with sensitive data.
- The repository being public means its code, history, issues, and pull-request discussions may be visible and copied. Removing a file in a later commit does not erase it from Git history or other copies.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Changes should be focused, tested, documented, and merged only after required CI checks pass.

## License

ORIENT is licensed under the [MIT License](LICENSE). The license applies to the repository's original code and documentation; third-party components remain subject to their own licenses. The `private: true` setting in `package.json` prevents accidental npm publication and does not itself grant or remove rights to the public Git repository.
