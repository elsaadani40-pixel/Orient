# Security Policy

## Scope and status

ORIENT ONE is under active development and has not been represented as independently security-certified. Security controls and tests cover specific behaviors; they do not prove the absence of vulnerabilities.

## Reporting a vulnerability

**Do not report exploitable vulnerabilities, secrets, or personal data in a public issue or pull request.**

Use GitHub's private vulnerability reporting / security advisory feature for this repository if it is available. If it is not available, contact the repository maintainer through a private channel linked from the maintainer's GitHub profile and share only the minimum information needed to reproduce the issue.

Please include:
- affected commit or release;
- impact and preconditions;
- minimal reproduction steps or a proof of concept;
- any suggested mitigation, if known.

Allow time for triage and a fix before public disclosure. Do not access, modify, or retain other people's data while investigating.

## Secrets and sensitive data

Never commit:
- API keys, access tokens, passwords, private keys, certificates, or signing material;
- production database URLs or credentials;
- personal memory stores, agent state, execution checkpoints, logs, customer data, or real user prompts containing private information;
- local environment files, backups, generated audit bundles, or dumps that may contain any of the above.

Use environment variables or an approved secret manager. Keep privileges and access scopes minimal. Rotate any credential that may have been exposed; deleting it from the latest commit is not sufficient because Git history, forks, caches, and clones may retain it.

## Safe use

- Run ORIENT ONE with test data until its security boundaries have been independently reviewed for your use case.
- Keep network-facing services bound to localhost unless a reviewed deployment configuration explicitly requires otherwise.
- Use least-privilege database credentials and separate test/development data from production data.
- Treat tool inputs, project files, model output, and external content as untrusted.
- Require human approval for consequential operations and verify authorization at the execution boundary.
- Report security claims narrowly and tie them to tests or evidence.

## Supported versions

Only the current default branch is actively receiving security fixes at this stage. No release support or response-time SLA is promised.
