# Contributing

Thank you for helping improve ORIENT ONE. The project prioritizes correctness, clear ownership, safe execution, and reproducible evidence over the size of a change.

## Before changing code

1. Read `AGENT.md` and the relevant architecture/security documents.
2. Inspect the existing implementation and tests before introducing a new abstraction.
3. Define the intended behavior and failure cases.
4. Keep changes focused; avoid unrelated refactors.
5. Never include secrets, runtime state, personal data, generated audit bundles, or private customer data.

## Validation

Run the relevant checks locally when possible:

```bash
npm ci
npm test
npm run check:syntax
```

For runtime, persistence, authorization, recovery, and sandbox changes, add regression tests for both expected behavior and failure boundaries. PostgreSQL-related changes should be tested against PostgreSQL, not only mocked repositories.

## Pull requests

A pull request should explain:
- the problem and root cause;
- the chosen design and relevant alternatives;
- security and compatibility implications;
- tests run and their actual results;
- limitations or follow-up work.

Do not claim checks passed unless their results are available. Do not merge a change until required Strict CI jobs pass. Never place vulnerability details in public discussions; follow [SECURITY.md](SECURITY.md).

## Architecture rules

- Preserve the canonical runtime and explicit authorization boundaries.
- Do not bypass policy/authorization by calling sensitive tools directly.
- Do not introduce uncontrolled self-modification or an alternate execution owner.
- Prefer open-source, replaceable, local-first components where practical.
- Document whether a capability is implemented, proposed, or planned.
