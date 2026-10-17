# ORIENT

**A governed, local-first personal AI runtime — alpha.**

ORIENT is an actively developed personal AI system for planning and executing work through a canonical runtime. Permissions, authorization, execution state, and recovery belong to the runtime; client interfaces must not bypass those controls.

> **Release status:** early alpha. This repository is not a claim that every planned capability is complete, secure for production, or accepted on real devices. Check the current CI and the limitations below before use.

## Run ORIENT in about 5 minutes

**Requirements:** Node.js 22+, npm. PostgreSQL and a paid model API are optional.

```bash
git clone https://github.com/elsaadani40-pixel/Orient.git
cd Orient
npm ci
export ORIENT_OWNER_BOOTSTRAP_PASSWORD='replace-with-a-unique-secret-of-14-chars-or-more'
npm start
```

Keep the password private; do not commit it or use a password from another account. On first run, ORIENT stores a password hash and requires the owner to rotate the password after sign-in.

Open these local routes:

- Landing page: http://127.0.0.1:8080/
- Sign-in / registration: http://127.0.0.1:8080/auth
- Task workbench: http://127.0.0.1:8080/workbench
- Owner console: http://127.0.0.1:8080/owner
- Execution dashboard: http://127.0.0.1:8080/dashboard
- Memory interface: http://127.0.0.1:8080/memory

The default listener is loopback-only. Do not expose it to a public network. Owner routes require an authenticated owner session.

## Try one runtime request

With the server running, use another terminal:

```bash
curl -sS -X POST http://127.0.0.1:8080/agent \
  -H 'Content-Type: application/json' \
  -d '{"input":"احفظ أنني أختبر ORIENT"}'
```

Inspect the returned status and verify the memory through the local interface. An HTTP response alone does not prove every downstream action succeeded. Without a configured local model provider, deterministic planning rules are used; Ollama can be configured for local-model planning. No paid model API is required for this example.

## Verify before contributing

```bash
npm run check:syntax
npm test
```

Tests can require Linux sandbox facilities and a supported Node environment; a failure on another environment must be investigated rather than bypassed. Check [current CI](https://github.com/elsaadani40-pixel/Orient/actions) for the exact commit's results.

## What this alpha is — and is not

Implemented code includes a canonical runtime, agent/planning components, governed tool capabilities, local persistence adapters, an HTTP interface, and web interfaces. Exact behavior depends on configuration and passing tests. Cross-device completeness, production readiness, external security review, and full real-device/browser acceptance are **not implied**.

- Architecture and contributor rules: [AGENT.md](AGENT.md), [CONTRIBUTING.md](CONTRIBUTING.md)
- Security boundaries: [SECURITY.md](SECURITY.md), [Threat model](docs/security/THREAT-MODEL.md)
- Operational dashboard and task workbench: [Dashboard](docs/operations/DASHBOARD-CONTROL-PLANE.md), [Workbench](docs/operations/TASK-WORKBENCH.md)
- Demo walkthrough: [docs/DEMO.md](docs/DEMO.md)

## Security and data

Never commit credentials, API keys, private keys, customer data, personal memories, database URLs, or local runtime state. Review [SECURITY.md](SECURITY.md) before using sensitive data. Do not treat this alpha as a hardened production system.

## License

[MIT](LICENSE) for original repository content; third-party components remain subject to their own licenses.
