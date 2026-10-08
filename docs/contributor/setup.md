# Development Setup Guide

This guide provides comprehensive instructions for setting up the Rayfin development environment.

## Prerequisites

### Required Software

- **Node.js v20+** - [Download](https://nodejs.org/) or use [nvs](https://github.com/jasongin/nvs) for version management
- **[.NET SDK 8.0](https://dotnet.microsoft.com/download/dotnet/8.0)** - Required for backend services
- **[Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)** - For authentication with Fabric SQL
- **[Rush CLI](https://www.npmjs.com/package/@microsoft/rush)** - Installed via npm: `npm i -g @microsoft/rush`
- **[Git](https://git-scm.com/)** - Version control

### Development Tools

- **Visual Studio Code** - Recommended IDE
- **Docker Desktop** - For containerized development (optional)

## Repository Setup

### 1. Clone the Repository

```bash
git clone https://github.com/microsoft/project-rayfin.git
cd project-rayfin
```

### 2. Install Dependencies (Rush)

Use Rush for deterministic installs, linking, and change tracking.

```bash
rush update
```

Do not run `npm install` within individual package folders.

### 3. Build All Projects

Full recommended build (TypeScript packages + .NET solution):

```bash
rush build && dotnet build
```

### 4. Targeted / Incremental Builds

Rush understands the project graph and only builds what is needed.

```bash
# Build a specific package (and its dependencies)
rush build --to @microsoft/rayfin-core

# Build everything that depends on a package (reverse traversal)
rush build --from @microsoft/rayfin-data

# Force rebuild ignoring cache for a subtree
rush rebuild --to @microsoft/rayfin-data
```

### 5. Cleaning

```bash
# Clean outputs (fast)
rush clean

# Deep clean all install state and caches (then re-install)
rush purge && rush update

# Convenience script (legacy) still available
npm run clean
```

### 6. Watching / Live Development

Use `rushx` to invoke per package watch scripts.

```bash
# Example: run a package's watch script
rushx --to @microsoft/rayfin-core build:watch
```

Add additional watch scripts to individual `package.json` files as needed.

### 7. VS Code Build Task

You can trigger the build via the default VS Code build task.

```text
Ctrl + Shift + B
```

Preferred underlying command is `rush build` (then `dotnet build` if needed).

## Azure Authentication Setup

Rayfin uses **Fabric SQL Database** with **Active Directory Default** authentication.

### 1. Install Azure CLI

[Download and install Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)

### 2. Login to Azure

```bash
az login
```

### 3. Verify Authentication

```bash
az account show
```

The WebService will automatically use these credentials for database connections.

## Rush Commands Quick Reference

Use these core Rush commands for efficient development.

### Essential

```bash
# Install dependencies
rush update

# Build all changed projects (cached)
rush build

# Force rebuild (ignore cache)
rush rebuild

# Full stack (TypeScript + .NET)
rush build && dotnet build
```

### Targeted

```bash
# Build a package and its deps
rush build --to @microsoft/rayfin-data

# Build everything that depends on a package
rush build --from @microsoft/rayfin-data

# Multiple explicit targets
rush build --to @microsoft/rayfin-core --to @microsoft/rayfin-data
```

### Testing

```bash
# All tests
rush test

# Tests for a subtree
rush test --to @microsoft/rayfin-core

# Impacted tests since a prior commit
rush test --impacted-by git:HEAD~1
```

### Maintenance

```bash
# Clean outputs
rush clean

# Deep clean and reinstall
rush purge && rush update
```

### Per Package Scripts (rushx)

```bash
# Run a package defined script
rushx --to @microsoft/rayfin-core lint
```

### Guidelines

- Prefer Rush over raw npm workspace flags.
- Run commands from the repository root.
- Use `--to` / `--from` for graph scoped builds and tests.
- Reserve `rush purge` for inconsistent state recovery.

## Docker Development Environment

Rayfin uses Docker containers for PostgreSQL (control plane), SQL Server (user app data), Azurite (storage), and the WebService.

### Unified Workflow: rayfin dev

> **Note:** `rayfin dev` requires `RAYFIN_FEATURE_FLAGS=docker-local-dev`.

The recommended approach is to use `rayfin dev` with docker-compose override files. This provides a unified workflow that matches the Builder experience while enabling local WebService testing.

#### Quick Start: Local WebService Development

For contributors any end-to-end testing is done by running and testing the todo-app. To test CLI/SDK/local WebService changes end-to-end with hot-reload and debugging:

```bash
# Infrastructure with locally built WebService
cd samples/todo-app
rushx rayfin:dev:local

# Launh Todo app FE
rushx dev:rayfin
```

This command:
- Starts all infrastructure based on rayfin.yml(PostgreSQL, SQL Server, Azurite, Functions, Telemetry)
- Builds a debug-enabled WebService container from local source
- Enables hot-reload (2-5 second feedback loop for C# changes)
- Supports VS Code remote debugging

**What gets hot-reloaded without rebuilding:**
- C# source file changes (`.cs`)
- Project file changes (`.csproj`)
- NuGet package additions (auto-restore)

**When to rebuild the image:**

```bash
# Rebuild image and launch infrastructure with locally built WebService
rushx rayfin:dev:local:rebuild
```

Use after:
- Modifying `Dockerfile.development`
- Adding new projects to the solution

**VS Code Debugging**

Attach the debugger to the containerized WebService:

1. Start the local WebService: `rushx run rayfin:dev:local`
2. In VS Code, press `F5` or go to Run and Debug
3. Select "Attach to WebService (todo-app Docker)"
4. Pick the `dotnet` process when prompted
5. Set breakpoints in `packages/host/**/*.cs` files

#### Alternative: Test CLI/SDK only changes with published WebService

If the changes are limited to CI/SDK and we plan to use published WebService image in GH Container Registry

```bash
# Infrastructure with remote WebService image
cd samples/todo-app
rushx rayfin:up

# Launh Todo app FE
rushx dev:rayfin
```

#### DEPRECATED: Alternative: Infrastructure-Only + Native WebService (Could be deprecated)

If you prefer no Docker overhead for WebService setup and testing, spin the backend separately and follow it up with running WebService:

```bash
# Start PostgreSQL only (control plane)
cd packages/host
docker-compose -f docker-compose.developer.yml up -d

# Start with Data API (adds SQL Server)
docker-compose -f docker-compose.developer.yml --profile data-api up -d

# Stop all containers
docker-compose -f docker-compose.developer.yml down

# Run the Webservice
cd Microsoft.Rayfin.WebService
dotnet run

# Terminal 2: Launch Todo app FE
cd samples/todo-app
rushx dev:rayfin
```

This uses the standard `rayfin dev` workflow (pulls WebService from GHCR) and runs your local WebService natively alongside the infrastructure.

### Data Feature Configuration

The `Data:Enabled` flag in `appsettings.json` controls Data API features:

- **`Data:Enabled=false`** (default): PostgreSQL only, no SQL Server needed
- **`Data:Enabled=true`**: Requires SQL Server via `--profile data-api`

**Important**: When `Data:Enabled=true`, you must start Docker with `--profile data-api` to run SQL Server container.

### Environment Variables (Port Customization)

Customize ports to avoid conflicts with existing services:

```powershell
# PowerShell
$env:RAYFIN_POSTGRES_PORT = "5433"
$env:RAYFIN_SQLSERVER_PORT = "1434"
docker-compose -f docker-compose.developer.yml --profile data-api up -d
```

```bash
# Bash
export RAYFIN_POSTGRES_PORT=5433
export RAYFIN_SQLSERVER_PORT=1434
docker-compose -f docker-compose.developer.yml --profile data-api up -d
```

**Available Environment Variables:**

- `RAYFIN_POSTGRES_PORT` - PostgreSQL host port (default: 5432)
- `RAYFIN_SQLSERVER_PORT` - SQL Server host port (default: 1433)
- `RAYFIN_AZURITE_BLOB_PORT` - Azurite blob port (default: 10000)
- `RAYFIN_AZURITE_QUEUE_PORT` - Azurite queue port (default: 10001)
- `RAYFIN_AZURITE_TABLE_PORT` - Azurite table port (default: 10002)

### Troubleshooting Local Development

**Container won't start:**

```bash
# Check logs
docker compose -f rayfin/.temp/docker-compose.yml -f docker-compose.override.yml logs webservice

# Verify container exists
docker ps -a
```

**Hot-reload not working:**

- Ensure `DOTNET_USE_POLLING_FILE_WATCHER=true` is set (already configured in override)
- Try saving the file again (initial file watch setup takes 2-3 seconds)
- Check that you're editing files in `packages/host/` (mounted volume)

**Debugger won't attach:**

- Verify container name: `docker ps` (should show `todo-app-webservice-1`)
- Ensure vsdbg is installed: `docker exec todo-app-webservice-1 ls /vsdbg/vsdbg`
- Check source mapping in launch.json matches your workspace folder

**Slow performance on Windows:**

- Ensure Docker Desktop uses WSL2 backend (Settings > General > Use WSL 2)
- Consider using the native WebService approach (infrastructure-only + `dotnet run`)

### Database Architecture

- **Control Plane (PostgreSQL)**: Users, Sessions, DabConfigurations, GraphQLSchemas, SchemaVersions
- **User App Data (SQL Server)**: User-defined entities (Categories, Todos, Orders, etc.)

Both databases are auto-created by the WebService on first run.

## Development Workflow

### Running the Backend Service

```bash
cd packages/host/Microsoft.Rayfin.WebService
dotnet run
```

The service will start on `http://localhost:5168`.

### Running Sample Applications

For the todo app:

```bash
cd samples/todo-app
npm run dev
```

### Running Tests

```bash
# All tests (Rush orchestrated)
rush test

# Specific subtree
rush test --to @microsoft/rayfin-core

# End to end CLI tests (script)
npm run test:e2e
```

## VS Code Configuration

### 1. Install Recommended Extensions

VS Code will prompt you to install workspace-recommended extensions.

### 2. Available Tasks

- **Build**: `Ctrl + Shift + B` - Builds both TypeScript and .NET projects
- **todo-app:dev**: Starts the todo-app development server

### 3. Debugging

Configure debugging through VS Code's Run and Debug panel for both Node.js and .NET projects.

## Troubleshooting

### Common Issues

1. **TypeScript compilation errors**: Ensure you're using TypeScript 5.8+
2. **Import helpers errors**: Make sure `importHelpers` is set to `false` in project tsconfig files
3. **Database connection issues**: Verify Azure CLI authentication with `az account show`
4. **Build failures**: Try cleaning and rebuilding:

   ```bash
   rush build --clean
   rush build && dotnet build
   ```

### Getting Help

- Check the [main README](../../README.md) for general information
- Review [development documentation](./README.md) for technical details
- See [authentication architecture](./host/authentication-architecture.md) for auth-related issues
