# Rayfin Developer Documentation

This directory contains technical documentation for Rayfin developers.

## Setup

- [Development Setup Guide](setup.md) - Complete development environment setup

## SDK

TypeScript SDK packages and client libraries.

- [JavaScript/TypeScript Overview](sdk/js_overview.md) - JavaScript/TypeScript development for Rayfin
- [TypeScript Auth API](sdk/typescript-auth-api.md) - Client-side authentication API
- [CLI Up Command](sdk/cli-up-command.md) - Rayfin CLI deployment command
- [Using the CLI UX skill for feature specs](cli-feature-spec-skill/README.md) - How to use `rayfin-cli-ux` when drafting contributor CLI feature specs
- [CLI Environment Targeting](cli-environment-targeting.md) - Internal `RAYFIN_*` env vars for targeting alternate Fabric environments
- [Package Publishing Guide](sdk/package-publishing-guide.md) - Publishing packages to GitHub Packages

## Host

.NET host services, authentication, and infrastructure.

### Architecture & Development

- [Authentication Architecture](host/authentication-architecture.md) - Stateless JWT authentication system
- [Testing Auth API](host/testing-auth-api.md) - Authentication endpoint testing
- [.NET Overview](host/dotnet_overview.md) - .NET development for Rayfin
- [Rayfin PoC Architecture](host/rayfin-poc-architecture.md) - High-level architecture and data flows
- [Functions Core Architecture](host/functions-core-architecture.md) - Functions architecture and management
- [RFC Function Management](host/rfc-function-management.md) - Function management RFC

### Configuration & Deployment

- [Database Migrations](host/database-migrations.md) - Managing database schema changes
- [Fabric SQL Configuration](host/fabric-sql-configuration.md) - Fabric SQL Database setup
- [Storage Configuration](host/storage-configuration.md) - Storage service configuration
- [Docker Overview](host/docker_overview.md) - Using Docker with Rayfin
- [Container Publishing Setup](host/container-publishing-setup.md) - Container registry configuration

### Package Publishing

- [Versioning Guide](host/versioning.md) - Centralized versioning system for NuGet packages
- [Publishing Guide](host/publishing.md) - Building and publishing NuGet packages to Azure Artifacts

## Samples

Samples apps to use for development testing.

- [Overview and how to turn samples into user templates](../../samples/README.md)

## Research

- [Research](research/) - Experimental features and exploratory work

## Build System

This project is polyglot, including TypeScript and .NET, each with their own toolchains:

- **.NET**: Traditional solution-based structure with `rayfin.sln`
  - `dotnet build` - Build all .NET projects

- **TypeScript**: Workspace-based monorepo with shared `tsconfig.base.json`
  - Getting started

      ```bash
      npm i -g @microsoft/rush # global install is required, but will use project specific version

      rush update # install and link
      rush build # build
      rush test # test
      rush format # runs prettier
      rush lint # runs eslint
      rush docs:lint # runs markdown linter

      rush -h # displays all commands
      rush build -h # displays help for a given command (build in this case)
      ```

  - **Project commands**
    - Run command for a specific project:
      - `rush build --only @microsoft/rayfin-cli`
      - Alternatively, you can use `rushx` within a project's directory. For example, `rushx build` from the `./packages/tools/cli` directory will build the cli.
      - Caution: `npm run` and `npm exec` still works, but do not use any other npm commands.
    - Run a command for a package and everything it depends on:
      - from anywhere: `rush build --to @microsoft/rayfin-cli`
      - in directory: `rush build --to .`
    - Run a command for all sdk packages: `rush build --to tag:sdk`
    - For more, see [Rush's selecting subsets docs](https://rushjs.io/pages/developer/selecting_subsets/)

  - **Subspaces**
    - Subspaces are rush's concept for compartmentalizing projects. We use them to isolate the samples. If you want to exclude the samples, you can use subspaces for both install and commands like so:

    ```bash
    rush update --subspace default
    rush build --to subspace:default
    rush test --to subspace:default
    ```

    - For most day to day usage, you can ignore subspaces. Beyond install boundaries, using subspaces and tags for scoping offer no real differences.

## VS Code Integration

- **Tasks**: `Ctrl + Shift + B` for default build, `todo-app:dev` for development server
- **Extensions**: Install workspace-recommended extensions
- **Debugging**: Available for both Node.js and .NET projects
