---
name: run-cli-e2e-locally
description: >-
  Run the CLI E2E tests locally using your own user credentials instead of
  a service principal. Use when: run e2e locally, run cli tests, test with
  my credentials, local e2e, e2e user auth, run fabric tests locally.
license: MIT
metadata:
  author: rayfin
  version: "2.0"
---

Help a developer run the CLI E2E tests locally using their own Azure AD credentials.

**Prerequisites**:

- The repo is cloned and Rush dependencies are installed (`rush update`)
- The CLI and E2E packages are built (`rush build --to rayfin-cli-e2e`)
- The user has an Azure AD account with access to the target Fabric workspace

## Steps

### 1. Create the local environment file

Create `packages/tools/cli-e2e/.env` (this file is gitignored):

```env
E2E_AUTH_MODE=user
E2E_ENVIRONMENT=daily
E2E_TENANT_ID=<your-tenant-id>
E2E_CLI_SOURCE=source
USE_LOCAL_PACKAGES=true
RAYFIN_E2E_WORKSPACE_NAME=DO_NOT_DELETE_AppDev_E2E_Workspace
RAYFIN_TELEMETRY_OPTOUT=1
RAYFIN_ENCRYPTION_FALLBACK_ENABLED=true
```

Replace `<your-tenant-id>` with the user's Azure AD tenant ID.

If the user doesn't know their tenant ID, suggest:

```bash
rayfin login status
```

or check the Azure Portal under **Microsoft Entra ID → Overview → Tenant ID**.

### 2. Run the tests

From `packages/tools/cli-e2e`:

```bash
rushx test:e2e
```

**Login is automatic.**
The test suite includes a `globalSetup` that checks for an existing user session before tests run.
If no valid user session exists, it automatically runs `rayfin login --tenant <E2E_TENANT_ID>` which opens the browser for interactive sign-in.
After authenticating once, subsequent test runs reuse the cached session without prompting again.

To run a specific test file:

```bash
rushx test:e2e -- src/init/init.test.ts
```

To run with coverage:

```bash
rushx test:e2e:coverage
```

To run in watch mode during development:

```bash
rushx test:e2e:watch
```

### 3. Run the Playwright browser E2E tests

First install Playwright browsers (one-time):

```bash
npx playwright install chromium
```

Then run the browser tests:

```bash
rushx test:e2e:browser
```

**Note**: The browser tests deploy to a Fabric workspace and navigate to the hosted URL.
They require the user's account to have Contributor access to the `DO_NOT_DELETE_AppDev_E2E_Workspace` workspace.
The Playwright tests do **not** use the Vitest globalSetup, so the user must have a valid session from a prior `rushx test:e2e` run or manual `rayfin login --tenant <id>`.

### 4. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `E2E_AUTH_MODE=user requires E2E_TENANT_ID to be set` | Fill in `E2E_TENANT_ID` in your `.env` file |
| `Interactive login failed` + browser did not open | Run manually: `rayfin login --tenant <id>` |
| `Silent token acquisition failed` | Token expired — re-run `rayfin login --tenant <id>` or delete `~/.rayfin/auth.json` and retry |
| `Workspace not found` | Verify your account has access to `DO_NOT_DELETE_AppDev_E2E_Workspace` in the daily Fabric environment |
| Tests skip with `Skipped: authMode === 'user'` | Expected — SP-specific tests are skipped in user mode |
| Tests skip with `data-client tests require SP credentials` | Expected — data-client tests need SP secrets |
| Keychain errors (WSL/containers) | Set `RAYFIN_ENCRYPTION_FALLBACK_ENABLED=true` in `.env` |
| Windows libuv assertion crash during login | Harmless — the globalSetup checks CLI output content, not exit code |

## How It Works

- **Automatic login via globalSetup**: The Vitest config references `src/global-setup.ts` which runs before all tests.
  When `E2E_AUTH_MODE=user`, it checks `rayfin login status` output.
  If not signed in as a user, it triggers `rayfin login --tenant <E2E_TENANT_ID>` (opens browser).
  On subsequent runs, the cached session is reused and login is skipped.
- **Output-based detection**: On Windows, `rayfin login` may crash during process cleanup (libuv assertion) even after success.
  The setup checks for `"Signed in successfully"` in stdout rather than relying on exit code.
- **Auth state sharing**: CLI commands in tests inherit the user's auth from `~/.rayfin/auth.json`.
  Direct Fabric API calls acquire a token silently from the MSAL cache via the CLI's `getAuthenticatedToken()` function.
- **Test skipping**: Service principal-specific tests (SP login, SP logout) are automatically skipped via `it.skipIf(authMode === 'user')`.
- **CI isolation**: CI always sets `E2E_AUTH_MODE=sp` with pipeline secrets.
  Local `.env` files are gitignored and never affect CI.
