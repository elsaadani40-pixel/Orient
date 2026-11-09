# OpenMausBot integration

**Status:** Phase 1 read-only adapter implemented on a review branch; not enabled by default and not yet accepted as a release capability.

ORIENT can optionally inspect a separately running [OpenMausBot](https://github.com/milind-soni/OpenMausBot) agent fleet through its MCP stdio server. OpenMausBot is not installed, vendored, or required by ORIENT. The application consumes a provider-neutral external-agent contract; the OpenMausBot-specific MCP protocol and tool names are confined to its infrastructure adapter. This keeps future providers from requiring changes to ORIENT's runtime or planner.

## Enable read-only discovery

Install and start OpenMausBot on a supported desktop host, then make its MCP command available to the ORIENT process. The default command is:

```sh
openmausbot mcp
```

Set these environment variables for the ORIENT process:

```sh
ORIENT_OPENMAUSBOT_ENABLED=true
# Optional overrides:
ORIENT_OPENMAUSBOT_MCP_COMMAND=openmausbot
ORIENT_OPENMAUSBOT_MCP_ARGS='["mcp"]'
ORIENT_OPENMAUSBOT_TIMEOUT_MS=15000
```

The adapter forwards only these OpenMausBot connection variables to the child process when they are set:

- `OPENMAUSBOT_URL`
- `OMB_PORT`
- `OPENMAUSBOT_TOKEN`
- `OPENMAUSBOT_MCP_TIMEOUT_MS`

For a paired desktop app, create a one-time pairing code in OpenMausBot's **Settings → Phone**, exchange it locally using the upstream documented pairing flow, and set the resulting token in the ORIENT process environment. When a token is set, also set an explicit `OPENMAUSBOT_URL` or `OMB_PORT`; upstream refuses token-bearing port discovery so the token is not sent to unrelated local services.

Do not paste tokens into chat, source files, command-line arguments, task prompts, or logs. Use the host's secret environment or secret manager. Revoke the paired client in OpenMausBot when it is no longer needed.

For a remote desktop host, use HTTPS or an explicitly controlled private network/Tailscale address. Do not expose plain HTTP over the public internet. The upstream MCP server validates its endpoint origin; the ORIENT adapter also runs with `shell: false` and does not accept command, arguments, endpoint, or credentials from model input.

## What ORIENT exposes

When enabled, the Research Agent may use only these read-only tools:

| ORIENT tool | OpenMausBot MCP tool | Effect |
|---|---|---|
| `openmausbot.health` | `get_system_health` | Read-only |
| `openmausbot.list_bots` | `list_bots` | Read-only |
| `openmausbot.list_channels` | `list_channels` | Read-only |
| `openmausbot.list_models` | `list_available_models` | Read-only |

Every request starts a bounded MCP child process, performs MCP initialization, verifies the health response identifies OpenMausBot, checks the strict upstream tool allowlist, calls the selected read-only operation, bounds the response, and terminates the child. The child receives a minimal environment; unrelated ORIENT database and owner secrets are not inherited.

Upstream results are marked untrusted. They are observations, not instructions, permissions, or proof that a user task was completed.

## Explicitly not enabled

This first slice does **not** send messages, create agents, edit profiles, switch models, read transcripts, interrupt jobs, access computers/VMs, run shell commands, or invoke connected apps. No upstream tool is automatically exposed merely because it appears in `tools/list`.

Controlled delegation is a separate phase. It must bind an ORIENT approval to the exact target and request, use upstream idempotency identifiers, persist external receipts, reconcile retries, and retain OpenMausBot's own ask-before-act controls. An ORIENT approval to dispatch a task cannot approve every later action the external agent might attempt.

## Runtime and licensing

ORIENT targets Node.js `>=22`; the current OpenMausBot package targets Node.js `>=24`. Keep them in separate processes rather than raising ORIENT's runtime requirement or embedding Electron.

OpenMausBot's repository root is Apache-2.0, but its `enterprise/` directory is separately licensed. ORIENT does not copy or redistribute upstream source in this integration. Review upstream licensing and trademark rules before any future redistribution or white-labeling.
