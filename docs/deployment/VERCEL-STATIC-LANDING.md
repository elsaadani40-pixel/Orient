# Vercel static landing page

## Purpose

Vercel hosts the public-facing ORIENT marketing landing page from the existing source at `website/index.html`. The static deployment is intentionally separate from the ORIENT Runtime API and owner account system.

## Build runtime

The Vercel project and package engine are both pinned to Node.js 22.x. The package engine must be explicit because Vercel gives `package.json` precedence over the project-level Node setting; a broad `>=22` range can silently select a newer major runtime. Strict CI runs Node 22 as the supported baseline and Node 24 as a forward-compatibility check.

## Build contract

The repository build command is:

```sh
npm run build:vercel
```

It runs `scripts/build-vercel-static.js`, which:

1. Requires `website/index.html` to exist as a regular file.
2. Recreates `.vercel-static/`.
3. Copies the source page to `.vercel-static/index.html`.
4. Reads the generated file and verifies byte-for-byte equality with the source.
5. Fails the build if the source is missing or the output differs.

Vercel is configured by `vercel.json` to run that command and publish `.vercel-static`. The generated directory is ignored by Git.

## Local verification

```sh
npm ci
npm run build:vercel
cmp website/index.html .vercel-static/index.html
```

The output directory is generated; do not edit or commit its contents. Make website changes in `website/index.html`.

## Runtime and security boundary

This deployment contains only the static landing page. It does not provide:

- `/api/*` Runtime endpoints;
- registration, login, owner dashboard, or account sessions;
- PostgreSQL/Supabase connectivity;
- background workers or task execution.

The landing page intentionally hides its account action on non-local hosts until a real hosted authentication/runtime path is deployed and verified. Do not add client-side secrets or expose private owner APIs through this static project.

The Supabase database remains private to a trusted backend. Do not grant the Supabase Data API access to ORIENT runtime tables merely to make this static site appear connected.

## Release gates

A successful Vercel build is not a production release. Before promoting a public deployment:

- complete the manual desktop, phone, and tablet acceptance in issue #225;
- review HTTPS, durable session persistence, hosting controls, and security;
- complete the backend/runtime deployment design and its secret provisioning;
- keep async workers disabled until issue #189 is closed;
- obtain explicit owner authorization for merge and production promotion as required by issue #320.

The preview may remain behind Vercel SSO. A custom ORIENT-owned domain has not yet been supplied/configured; use the Vercel project domain only as a temporary preview address.
