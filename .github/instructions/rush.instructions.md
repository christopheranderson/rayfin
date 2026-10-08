---
applyTo: '**/*'
---

Rush monorepo expert for the Rayfin project. Assist with Rush tasks following project conventions.

# 1. Configuration Files

- [`rush.json`](/rush.json): Main config (Rush 5.158.1, PNPM 10.17.1, Node.js >=20.0.0)
- [`common/config/rush/command-line.json`](/common/config/rush/command-line.json): Custom commands
- [`common/config/rush/subspaces.json`](/common/config/rush/subspaces.json): Subspace config (enabled)
- [`common/config/subspaces/`](/common/config/subspaces/): Subspace-specific configs (default, rayfin-cli, samples)
- [`common/scripts/install-run-rush.js`](/common/scripts/install-run-rush.js): Rush bootstrapper

# 2. Subspaces

Rayfin uses four subspaces for isolated dependency management:

- **`default`**: SDK packages (`@microsoft/rayfin-*` under `packages/typescript-sdk/`)
- **`rayfin-cli`**: CLI, MCP, docs tooling, package-doc projects, and E2E tests (`@microsoft/rayfin-cli`, `rayfin-cli-e2e`, `@microsoft/create-rayfin`, `@microsoft/rayfin-mcp`, `@microsoft/rayfin-docs`, `@microsoft/rayfin-guide`, `@microsoft/rayfin-host-docs`, `@microsoft/rayfin-tools-common`)
- **`samples`**: Sample apps (`todo-app`, `eshop`, `events-app` under `samples/`)
- **`docs`**: Docusaurus site (`docs/site`)

Each subspace has independent `pnpm-lock.yaml` and `common-versions.json` in [`common/config/subspaces/<name>/`](/common/config/subspaces/).
# 3. Project Categories

Projects organized under `projectFolderMaxDepth: 3`:

- `packages/typescript-sdk/`: SDK packages (auth, client, core, data, functions, storage, lib)
- `packages/tools/`: CLI, MCP, docs library, and shared tooling (cli, cli-e2e, create-rayfin, mcp, docs-lib)
- `packages/guide/`, `packages/host-docs/`: package-owned docs discovered through the `rayfinDocs` package.json convention
- `samples/`: Sample applications (not published)
- `docs/site/`: Docusaurus documentation site (Contributor tooling, not published)

View all projects in [`rush.json`](/rush.json) under `"projects"` field.

# 4. Command Usage

## 4.1 Command Tools

**Preferred:** Use the installed `rush` command directly:

- **`rush`**: Repo-wide or multi-project operations (install, build, publish)
- **`rushx`**: Execute project-specific scripts (like `npm run`)
- **`rush-pnpm`**: Direct PNPM commands with Rush context

**Fallback:** Use `common/scripts/install-run-rush.js` if the global version doesn't match:

```bash
node common/scripts/install-run-rush.js <command>
```

## 4.2 Essential Commands

**Install/Update:**
- `rush update`: Install/update dependencies, modify lock file
- `rush install`: Install from existing lock (CI-safe, read-only)
- `rush update -p`: Purge before installation
- `rush update --subspace <name>`: Update specific subspace only

**Build:**
- `rush build`: Incremental build (changed projects only)
- `rush rebuild`: Clean full rebuild
- `rush build:force`: Force rebuild ignoring cache (custom command in [`command-line.json`](/common/config/rush/command-line.json))
- `rush build:watch`: Watch mode for development

**Dependencies:**
- `rush add -p <package>`: Add dependency to current project
- `rush add -p <package> --dev`: Add dev dependency
- `rush remove -p <package>`: Remove dependency

**Testing:**
- `rush test`: Run tests for all projects (custom bulk command)
- `rush test:watch`: Watch mode using Vitest autoinstaller (custom global command)
- `rush test:coverage`: Generate coverage reports

**Code Quality:**
- `rush format`: Format code with Prettier
- `rush format:check`: Check formatting
- `rush lint`: Lint and fix with ESLint
- `rush lint:check`: Lint without fixing
- `rush docs:lint`: Markdown linting

**Maintenance:**
- `rush purge`: Clean `common/temp/` and `node_modules/`
- `rush clean`: Clean build outputs (custom bulk command)

## 4.3 Project Selection

**Target specific projects:**
- `--to <project>`: Build project and dependencies
- `--to-except <project>`: Build dependencies only
- `--from <project>`: Build project and consumers
- `--impacted-by <project>`: Build affected projects only
- `--only <project>`: Build single project, ignore dependencies

**Examples:**
```bash
rush build --to @microsoft/rayfin-core
rush build --to .  # Current directory's project
rush build --only @microsoft/rayfin-cli # Build single project only
rush test --from @microsoft/rayfin-data
rush build --impacted-by @microsoft/rayfin-lib
```

**Subspace selection:**
```bash
rush update --subspace rayfin-cli
rush build --subspace samples
```

# 5. Dependency Management

**Version policy:** Controlled via [`common/config/subspaces/<name>/common-versions.json`](/common/config/subspaces/)

**Subspaces isolate dependencies:** Each subspace has independent lock files to prevent cross-contamination between SDK, CLI, and samples.

**Never use `npm`, `pnpm`, or `yarn` directly** — always use `rush add`/`rush remove` for dependency changes.

# 6. Build Caching

Build cache accelerates builds by reusing outputs when inputs haven't changed. Cache stored in [`common/temp/build-cache/`](/common/temp/build-cache/).

**Configure per-project:** Create `config/rush-project.json`:

```json
{
  "operationSettings": [{
    "operationName": "build",
    "outputFolderNames": ["lib", "dist"],
    "disableBuildCacheForOperation": false
  }]
}
```

**Bypass cache:** Use `rush build:force` or `rush rebuild`.

# 7. Best Practices

**Troubleshooting:**
- Dependency issues: `rush purge && rush update`
- Build issues: `rush rebuild` to skip cache
- Detailed logs: Add `--verbose` to any command

**Workflows:**
- After clone: `rush update`
- After pull: `rush update` (or `rush install` for CI)
- After `package.json` change: `rush update`
- Quick build: `rush build`
- Clean slate: `rush purge && rush update && rush rebuild`

**Custom commands:** See [`common/config/rush/command-line.json`](/common/config/rush/command-line.json) for full list of Rayfin-specific commands.
