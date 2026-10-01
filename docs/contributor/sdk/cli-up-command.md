# Rayfin CLI `up` Command

This document explains the `up` command in the Rayfin CLI.
`rayfin up` deploys a project to Microsoft Fabric by creating or reusing a Rayfin item (`AppBackend`) and applying configuration to it.

## Overview

`rayfin up` is the Fabric-native deployment path for Rayfin.
It does not deploy Azure Container Apps or provision Azure resource groups.
Instead, it creates a Rayfin item in a Fabric workspace and applies configuration through workload management endpoints.

## Command Usage

```bash
rayfin up [options]
```

The command reads your project configuration from `rayfin/rayfin.yml`.
The project name is taken from `rayfin.yml` under `id`.

### Options

- `--workspace-id <id>`: Fabric workspace GUID to deploy into.
- `--force`: Allow destructive data schema changes when applying database configuration.
  This may result in data loss.
- `-n, --dry-run`: Validate local static-hosting inputs and resolve the workspace with read-only Fabric requests, without deploying or modifying resources.
- `--env-file <path>`: Defaults to `rayfin/.env` and contains Fabric app properties.
- `-v, --verbose`: Enable verbose output.
- `--encryption-fallback-enabled`: Allow plaintext token storage when the OS keychain is unavailable.
  Required only when login fails with a keychain error.
- `--exclude-services <names>`: Comma-separated list of services to skip during deployment.
  The only currently supported value is `staticHosting`.
  Names are matched case-insensitively against the canonical `rayfin.yml` keys.
  Excluding a service skips only its build/package/deploy phase — the runtime settings POST still reflects the project's true configuration, so the backend is never silently reconfigured.
  The canonical use case is local development where Vite serves the frontend, so you want the backend deployed but not the static bundle: `rayfin up --exclude-services staticHosting`.
  Unknown service names fail fast with a clear error.

## What the Command Does

When you run `rayfin up`, the CLI performs these high-level steps.

1. Loads `rayfin/rayfin.yml` and determines the target workspace.
2. Creates or reuses a Rayfin item (`AppBackend`) in the workspace.
3. Exchanges an Entra ID token for an MWC token to call workload management endpoints.
4. Retrieves the publishable key.
5. Posts project runtime settings (enabled services) to the workload.
6. If `services.data.enabled` is `true`, generates DAB configuration from your TypeScript models and applies it to the workload.
7. Writes `.env.production` with endpoint, publishable key, and project ID.
8. If `services.staticHosting.enabled` is `true`, runs the configured build command, packages the output folder into a ZIP, and deploys it to the workload's `/__private/webapp/deploy` endpoint.
9. Persists deployment metadata (including hosting URL when available) to `rayfin.yml`.

The command is designed to be idempotent.
Re-running `rayfin up` should converge the remote item to the same configuration.

## Deployment Persistence

After a successful run, `rayfin/rayfin.yml` is updated with deployment metadata.

```yaml
deployment:
  rayfinItemId: <fabric-item-id>
  rayfinItemEndpoint: <workload-endpoint-base-url>
  fabricWorkspaceId: <workspace-id>
  fabricDeepLink: <fabric-portal-deep-link>
  publishableKey: <publishable-key>
  hostingUrl: <static-hosting-url>  # present when static hosting is enabled
```

The CLI also writes deployment metadata to `rayfin/.deployments.json` and merges `RAYFIN_PUBLIC_*` variables into `rayfin/.env` for front-end integration:

```text
RAYFIN_PUBLIC_API_URL=<workload-endpoint-base-url>
RAYFIN_PUBLIC_PUBLISHABLE_KEY=<publishable-key>
RAYFIN_PUBLIC_ITEM_ID=<project-id>
RAYFIN_PUBLIC_WORKSPACE_ID=<workspace-id>
RAYFIN_PUBLIC_PORTAL_URL=<fabric-portal-url>
```

Run `rayfin env --framework vite` to generate a `.env.local` with Vite-compatible variable names.
The hosting URL is stored in `rayfin/.deployments.json` for reference but is not written to `rayfin/.env`.

Use `rayfin up list` to see all recorded deployments and `rayfin up switch <workspace>` to change the active one.

## Related Commands

### `rayfin up status`

Use `rayfin up status` to display the current deployment state for the project.
It prints cached deployment metadata from `rayfin.yml` and, when authenticated, live Fabric state (workspace, item, SQL database) and endpoint health.
Add `--json` for machine-readable output.

```bash
rayfin up status
rayfin up status --json
```

### `rayfin up db apply`

Use `rayfin up db apply` to (re)apply database configuration to an already deployed Rayfin item.
The command uses the endpoint stored in `rayfin.yml` (`deployment.rayfinItemEndpoint`).
Pass `--force` to allow destructive schema changes.

```bash
rayfin up db apply
rayfin up db apply --force
```

### `rayfin up staticapp deploy`

Use `rayfin up staticapp deploy` to (re)deploy static content to an already deployed Rayfin item.
The command reads the static hosting configuration from `rayfin.yml` and uses the persisted endpoint.

```bash
rayfin up staticapp deploy
rayfin up staticapp deploy --skip-build
rayfin up staticapp deploy --verbose
```

Pass `--skip-build` to deploy existing build output without re-running the build command.

## Unsupported or Deferred Operations

Remote storage configuration apply is not supported in the `rayfin up` flow.
There is no `rayfin up storage apply` command.

## Troubleshooting

### Authentication

The CLI authenticates via Entra ID using a native MSAL-based login flow.
Run `rayfin login` to authenticate.
Add `rayfin login --select` to force an account selection prompt.
The token cache uses the OS keychain when available.
If the OS keychain is unavailable, `rayfin login` and `rayfin up` now fail instead of silently storing tokens as plaintext.
To explicitly allow plaintext token storage after a keychain error, pass `--encryption-fallback-enabled` to `rayfin login` or `rayfin up`, or set `RAYFIN_ENCRYPTION_FALLBACK_ENABLED=true`.
If you run `rayfin up` while not authenticated, it will prompt you to sign in interactively.
`rayfin up status` does not auto-trigger login, so run `rayfin login` first if you need live status.

### Missing Deployment Metadata

If `rayfin up db apply` reports missing `fabricWorkspaceId` or `rayfinItemId`, run `rayfin up` first.
This command populates the deployment section in `rayfin.yml`.

### Workspace Not Found

If the CLI cannot find `My Workspace`, pass `--workspace-id <id>` explicitly.

## See Also

- [Rayfin CLI README](../../../packages/tools/cli/README.md)
- [Database Migrations](../host/database-migrations.md)
