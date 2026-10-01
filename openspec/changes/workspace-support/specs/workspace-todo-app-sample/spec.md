## ADDED Requirements

### Requirement: Sample directory exists under samples/workspace-todo-app

A new sample SHALL exist at `samples/workspace-todo-app/` in the repository.
The sample SHALL demonstrate a multi-package npm workspace layout where separate sub-packages handle the frontend, data models, and shared types, all wired through a single `rayfin/rayfin.yml` at the workspace root.

#### Scenario: sample directory is present in repository

- **WHEN** the repository is cloned
- **THEN** `samples/workspace-todo-app/` SHALL exist and contain a complete, runnable sample

---

### Requirement: Root package.json declares npm workspaces

The `samples/workspace-todo-app/package.json` SHALL include a `workspaces` field listing all sub-packages.
The sample SHALL use at least four sub-packages: one for the frontend app, one for data entity definitions, one for shared types, and one for functions.
The sample SHALL be structured as a Rush project wrapping a `template/` directory that contains the actual npm workspace.
The `template/` directory is the Builder-facing source of truth; `target/` is the generated build output (`.gitignored`).

#### Scenario: template contains a valid npm workspace

- **WHEN** `samples/workspace-todo-app/template/package.json` is inspected
- **THEN** it SHALL contain a `workspaces` field listing the sub-packages

#### Scenario: sample is not listed as a public scaffolding template

- **WHEN** the rayfin template registry is inspected
- **THEN** the `workspace-todo-app` template SHALL NOT be published as a public template (it is internal-only)

#### Scenario: sample is registered in rush.json

- **WHEN** `rush.json` is inspected
- **THEN** there SHALL be an entry for `samples/workspace-todo-app` in the `samples` subspace

---

### Requirement: Sub-packages follow the D6 package role profiles

Each sub-package SHALL follow the role profile defined in the design document (D6) appropriate to its runtime target:

- The frontend sub-package (browser-only) SHALL have `"type": "module"`, `"lib": ["ES2022", "DOM", "DOM.Iterable"]` in its `tsconfig.json`, and SHALL NOT include `@types/node`.
- The data/entities sub-package (Node.js-only) SHALL have `"type": "module"`, `"lib": ["ES2022"]` (no `DOM`) in its `tsconfig.json`, and SHALL include `@types/node` as a dev dependency.
- The shared types sub-package (isomorphic) SHALL have `"type": "module"`, `"lib": ["ES2022"]` (no `DOM`, no Node.js types), and SHALL NOT import from `node:*` built-ins or DOM APIs.

#### Scenario: frontend sub-package tsconfig excludes Node.js globals

- **WHEN** the frontend sub-package `tsconfig.json` is compiled
- **THEN** TypeScript SHALL NOT resolve Node.js built-in modules (e.g., `fs`, `path`) within that package

#### Scenario: data sub-package tsconfig excludes DOM globals

- **WHEN** the data sub-package `tsconfig.json` is compiled
- **THEN** TypeScript SHALL NOT resolve DOM types (e.g., `document`, `window`) within that package

#### Scenario: shared types sub-package compiles without DOM or Node.js globals

- **WHEN** the shared types sub-package `tsconfig.json` is compiled
- **THEN** TypeScript SHALL NOT resolve DOM types or Node.js built-in modules within that package

---

### Requirement: rayfin.yml at workspace root uses path and buildCommand fields to wire sub-packages

The `rayfin/rayfin.yml` at `samples/workspace-todo-app/rayfin/rayfin.yml` SHALL use per-service `path` fields to point each relevant service at its corresponding sub-package directory.
At minimum, `services.data.path` and `services.staticHosting.path` SHALL be set to demonstrate the feature.
The data service SHALL include a `buildCommand` to compile workspace dependencies before entity discovery.

#### Scenario: rayfin.yml contains path fields for data and staticHosting

- **WHEN** `samples/workspace-todo-app/rayfin/rayfin.yml` is parsed
- **THEN** `services.data.path` SHALL reference the data sub-package directory (e.g., `packages/data`)
- **THEN** `services.staticHosting.path` SHALL reference the frontend sub-package directory (e.g., `packages/frontend`)

#### Scenario: rayfin.yml contains buildCommand for data

- **WHEN** `samples/workspace-todo-app/rayfin/rayfin.yml` is parsed
- **THEN** `services.data.buildCommand` SHALL be set (e.g., `npm run build`)

#### Scenario: CLI resolves entity files from the data sub-package

- **WHEN** `rayfin dev` is run from `samples/workspace-todo-app/`
- **THEN** the CLI SHALL execute the data `buildCommand` from the data service root
- **THEN** the CLI SHALL discover entity definition files from the path indicated by `services.data.path`, not from the workspace root

---

### Requirement: Entity definitions are distributed across workspace packages

The sample SHALL demonstrate entity definitions split across multiple packages.
At minimum, one entity class SHALL live in the data package and one entity class SHALL live in the shared package.
The data package's `src/index.ts` SHALL re-export all entity classes from both packages.
The CLI SHALL discover entities via the data package's `package.json` exports entry point, without requiring a separate `rayfin/data/` re-export layer.
The combined schema type SHALL be assembled in the data package.

#### Scenario: entities from different packages are discovered

- **WHEN** the CLI runs entity discovery for the workspace sample
- **THEN** it SHALL find entities originating from both the data package (e.g., `Todo`, `Category`) and the shared package (e.g., `Image`)
- **AND** it SHALL have resolved them via the data package's `package.json` exports, not from `rayfin/data/` files

#### Scenario: schema type covers all entities

- **WHEN** the frontend imports `TodoAppSchema` from the data package
- **THEN** it SHALL include typed accessors for all entities across both packages

---

### Requirement: Sample is registered in rush.json via template-init pattern (D9)

The sample is registered as a single Rush project. Its build pipeline validates the template by running `rayfin init -t ./template`, linking local SDK packages, and building the output. See design decision D9.

#### Scenario: rush build validates the template

- **WHEN** `rush build --to workspace-todo-app` is run
- **THEN** the build SHALL succeed, proving the template is valid and `rayfin init -t` works correctly

---

### Requirement: Sample uses Fabric authentication

The frontend sub-package SHALL integrate Fabric sign-in via `@microsoft/rayfin-auth-provider-fabric`.
The sample SHALL use `ensureSignedInWithFabric()` for automatic session resume/refresh on page load, and a user-gesture-triggered popup broker for interactive sign-in.
When Fabric environment variables are not set, the frontend SHALL fall back gracefully (e.g., showing a message or skipping Fabric-specific steps).

#### Scenario: user authenticates via Fabric popup

- **WHEN** the user clicks "Sign in with Fabric" in the frontend
- **THEN** `ensureSignedInWithFabric()` SHALL attempt automatic sign-in first, then fall back to popup if needed

---

### Requirement: Template builds with npm install && npm run build

The template output (in `target/`) SHALL be buildable using only `npm install && npm run build`.
This is validated automatically by the Rush build pipeline, but Builders can also run it standalone from the `target/` directory.

#### Scenario: standalone build succeeds in target

- **WHEN** `npm install && npm run build` is run from `samples/workspace-todo-app/target/`
- **THEN** all packages SHALL compile without errors

---

### Requirement: Sample README documents the template layout and how to run it

The `samples/workspace-todo-app/README.md` SHALL explain the template-init structure, identify each sub-package and its role, and provide step-by-step instructions for Contributors to build/test and for Builders to use the template output.

#### Scenario: README contains workspace structure explanation

- **WHEN** `samples/workspace-todo-app/README.md` is read
- **THEN** it SHALL describe the purpose of each sub-package

#### Scenario: README provides runnable getting-started steps

- **WHEN** a Builder follows the README instructions from a clean clone
- **THEN** they SHALL be able to install dependencies with `npm install` and start the sample with a single command
