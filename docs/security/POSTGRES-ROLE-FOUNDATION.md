# PostgreSQL role foundation

Status: preparatory security slice; not a production deployment procedure yet.

This change defines four separate database roles:

| Role | Login | Purpose |
|---|---:|---|
| `orient_owner` | No | Owns ORIENT persistence objects and schema migrations |
| `orient_migrator` | Yes | Restricted migration identity; may assume `orient_owner` |
| `orient_runtime` | No | Holds only runtime table privileges and RLS policies |
| `orient_runtime_login` | Yes | Application login; inherits `orient_runtime`, never `orient_owner` |

## Provisioning command

The command is explicit and is not called by application startup:

```sh
ORIENT_ADMIN_DATABASE_URL='...' \
ORIENT_MIGRATOR_PASSWORD='a-generated-secret-at-least-16-characters' \
ORIENT_RUNTIME_PASSWORD='another-generated-secret-at-least-16-characters' \
npm run db:roles
```

Use a trusted administrative connection only from a protected operator environment. Do not put connection strings or passwords in source control, client bundles, issue comments, or chat. Store credentials in the database host's secret manager.

The script provisions roles and transfers ownership of known ORIENT tables/sequences. The invoking administrator must own the existing ORIENT persistence objects (or be a superuser), must have sufficient ADMIN OPTION to grant the intended role memberships, and must own the `public` schema or be a member of its owner role. On Supabase, `public` is owned by `pg_database_owner`, which is implicitly available to the database owner. `CREATEROLE` alone is not assumed to be sufficient. The trusted administrative login remains a member of `orient_owner` so it can perform controlled ownership transfer and schema/default-privilege administration. This credential must never be used by the application runtime; `orient_runtime_login` is separately verified not to be a member of `orient_owner`. The script verifies the required memberships because PostgreSQL may emit warnings rather than hard errors when a grant is not authorized; any missing membership aborts and rolls back the transaction.

## Important limitations

- This slice does not create tenant/owner/session RLS policies.
- It does not yet wire the application connection to `assertRuntimeDatabaseRole`.
- It does not yet wire the migration command to `assertMigrationDatabaseRole` or add `SET LOCAL ROLE orient_owner` migration execution.
- It does not migrate owner identity, memory, access-audit, or project-operation receipt stores.
- It has not been run against the hosted Supabase project.
- It is not approval to run `npm run db:roles` against production.

Before operational use, validate the provisioning script against PostgreSQL 17 with both a superuser and a managed non-superuser administrator. The non-superuser test must demonstrate successful provisioning when the administrator owns all existing ORIENT objects and can establish the intended memberships, plus fail-closed behavior when object ownership or required memberships are unavailable. Verify the resulting role attributes, memberships, object owners, grants, and default privileges. Follow with explicit RLS policy migrations and transaction-local tenant/owner/session context. Only then wire and enable the runtime login.

A successful role provisioning run alone does not establish tenant isolation or production readiness.
