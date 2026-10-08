## Context

`samples/universal-app` currently serves three roles in one directory: a Rush project linked to repository packages, the source copied into the Copilot plugin, and the generated Builder application.
Its root `package.json` therefore carries `workspace:*` development dependencies that the plugin bundler rewrites, template identity that the plugin stamps after copying, validation scripts, capability-pack state, and all application dependencies.

The completed `workspace-support` change already defines service-relative `path` and `buildCommand` semantics and establishes `samples/workspace-todo-app` as an outer Rush harness around a Builder-facing npm workspace under `template/`.
This change adopts that pattern for Universal App and depends on the prior [`workspace-path-resolution`](../workspace-support/specs/workspace-path-resolution/spec.md) and [`workspace-todo-app-sample`](../workspace-support/specs/workspace-todo-app-sample/spec.md) contracts rather than redefining CLI path resolution or generic workspace behavior.

The Universal App has additional constraints that the Todo sample does not:

- The Copilot plugin is its only distribution channel and must continue to bundle a stable template identity.
- Plugin policy and capability detection currently read the root manifest and fixed single-package paths.
- Capability packs mutate the root manifest and copy files into paths relative to the flat template.
- Functions is intentionally absent from the base and is created only when its capability pack is applied.

## Goals / Non-Goals

**Goals:**

- Separate repository validation from the generated Builder workspace by introducing an outer Rush harness and an inner `template/` source of truth.
- Establish explicit `frontend`, `data`, and `shared` package ownership while keeping `functions` opt-in.
- Preserve the generated app's root commands, template identity, authentication posture, and plugin workflow.
- Make plugin bundling, policy, capability detection, and capability packs aware of the workspace layout.
- Validate the inner template with published dependency semantics while exercising repository SDK code through outer-harness local links.
- Stage the migration behind passing characterization tests so each intentional assumption change is reviewable.

**Non-Goals:**

- Changing the generic service-path resolution behavior delivered by `workspace-support`.
- Publishing Universal App through `rayfin init` or registering it as a public CLI template.
- Adding automatic workspace discovery, a workspace migration command, or a new workspace manifest format.
- Creating a functions package in the base template or enabling functions by default.
- Changing Copilot plugin tool names, output schemas, capability names, authentication policy, or deployment semantics.
- Supporting package managers other than npm in the Builder-facing template.

## Decisions

### D1: Use an outer Rush harness and an inner npm workspace

**Decision**: `samples/universal-app/` becomes a thin Rush project that owns repository validation scripts, local SDK linking, and an ephemeral generated target.
`samples/universal-app/template/` becomes the only Builder-facing source copied into the Copilot plugin.
The harness follows the template-init validation pattern proven by `samples/workspace-todo-app`.

**Rationale**: The outer layer can use Rush `workspace:*` references without leaking them into generated apps.
The inner layer can be validated exactly as a Builder receives it, including npm workspace linking and published package ranges.

**Alternative considered**: Keep one directory and teach every consumer to transform it differently.
This preserves the current role collision and makes it impossible to inspect the committed generated-app source directly.

### D2: Give each inner package one runtime responsibility

**Decision**: The inner workspace contains these base packages:

- `packages/frontend`, named `@rayfin-app/frontend`, owns Vite, React, authentication bootstrap and guard, UI code, browser-only dependencies, and static-hosting output.
- `packages/data`, named `@rayfin-app/data`, owns Rayfin entity registration, schema exports, and Node.js build output consumed by Rayfin data discovery.
- `packages/shared`, named `@rayfin-app/shared`, owns isomorphic contracts shared by frontend, data, and future functions code.

The workspace root owns npm workspace membership, orchestration scripts, template identity, `rayfinPacks`, repository-independent validation commands, and `rayfin/rayfin.yml`.
It does not become a fourth application package.

**Rationale**: These boundaries match the browser-only, Node.js-only, and isomorphic role profiles already established by the workspace-support design.
Keeping orchestration at the root preserves the current `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run pack:add` entry points.

**Alternative considered**: Keep data definitions inside the frontend package.
That would preserve a single-package coupling and weaken the workspace example.

### D3: Functions remains absent until the capability pack creates it

**Decision**: The base template has no `packages/functions` directory and keeps `services.functions.enabled: false`.
Applying the canonical `functions` pack creates `packages/functions` with the stable package name `@rayfin-app/functions`, adds or confirms the functions workspace membership, sets `services.functions.path: packages/functions`, enables the service, and composes its package build into root orchestration.
The pack remains idempotent and preserves authored function files under the existing seed rules.

**Rationale**: Functions is a trusted-runtime capability, not a required Universal App layer.
An empty base functions package would advertise and install a capability the router deliberately treats as opt-in.

**Alternative considered**: Commit a disabled functions package.
This expands every scaffold and blurs the policy distinction between available and applied capabilities.

### D4: Service paths identify packages and build commands remain package-local

**Decision**: The inner root `rayfin/rayfin.yml` uses:

- `services.data.path: packages/data`, with a build command executed from that package root.
- `services.staticHosting.path: packages/frontend`, with its folder resolved under that package and its build command executed there.
- `services.functions.path: packages/functions` only after the functions pack is applied.

The command strings are package-local because the CLI sets `cwd` to the resolved service path.
Root orchestration scripts remain responsible for ordered full-workspace builds.

**Rationale**: This directly consumes the path and build-command semantics from `workspace-path-resolution`.
It avoids commands that incorrectly assume service build commands run from the workspace root.

**Alternative considered**: Point every service at `.` and have root scripts dispatch to packages.
That would hide the service-path feature this migration is intended to exercise.

### D5: Inner manifests model publication; the outer harness supplies local SDK links

**Decision**: Committed inner package manifests use published Rayfin ranges consistent with the Copilot plugin's supported range.
References between local workspace packages use `*`, allowing npm to link matching workspace members while remaining valid registry syntax if a member is later published.
No inner manifest contains `workspace:*` or repository-relative `file:` dependencies.

The outer harness links or rewrites Rayfin dependencies in an ephemeral validation target to the repository's local SDK packages before install and build.
It does not rewrite local member dependencies.

**Rationale**: A committed template should be installable outside the monorepo without a bundling transformation.
The generated target must still test the current repository SDK implementation rather than whatever is currently published.

**Alternative considered**: Keep `workspace:*` in the inner template and let the plugin bundler rewrite it.
That makes the committed source invalid for ordinary npm consumers and preserves a transformation the two-layer pattern makes unnecessary.

### D6: The plugin bundles the inner source and preserves one identity owner

**Decision**: The plugin bundler copies `samples/universal-app/template`, not the outer harness.
The inner root manifest carries the pinned Universal App template identity directly; the outer harness carries no identity that can be confused with the shipped template.
The bundler verifies the identity and dependency policy but does not create identity or convert inner `workspace:*` ranges.

**Rationale**: The committed Builder-facing source should be the same tree the plugin ships.
Eliminating semantic transformations makes drift visible in source review and harness tests.

**Alternative considered**: Continue stamping identity after copy.
That allows the source of truth to remain invalid until build time and obscures which manifest owns policy.

### D7: Policy and capability detection use a root control manifest plus workspace evidence

**Decision**: The inner root manifest remains authoritative for template identity, forbidden lifecycle scripts, root orchestration scripts, and `rayfinPacks`.
Dependency pin policy and package-based capability detection inspect the root manifest and declared workspace member manifests.
Rayfin configuration remains authoritative for enabled services and service paths.
Data schema detection resolves from the configured data package instead of assuming `rayfin/data/schema.ts`.

Policy fails closed when a declared workspace member manifest cannot be read, a required Rayfin dependency has an unsupported range, or capability evidence is ambiguous.
It does not require every package to repeat template identity or pack markers.

**Rationale**: Control-plane state belongs at the workspace root, while runtime dependencies belong to the package that imports them.
Root-only dependency inspection would stop protecting moved packages; member-only inspection would lose the stable app identity and pack audit record.

**Alternative considered**: Duplicate identity and `rayfinPacks` into every member.
That creates multiple mutable authorities and unnecessary merge logic.

### D8: Characterization tests precede assumption changes

**Decision**: Before restructuring, passing tests record that the current plugin:

- Bundles from the flat sample and stamps identity only on the vendored copy.
- Converts current `workspace:*` Rayfin declarations to the published range required by validation.
- Reads policy dependencies and manifest-derived capability markers from the root manifest.
- Applies the functions pack under `rayfin/functions` and composes root scripts around that path.

Later migration work updates those tests alongside production changes.

**Rationale**: These are intentional behavior changes with security and distribution implications.
Explicit characterization prevents accidental simultaneous changes from being mistaken for required migration work.

### D9: Builder compatibility is defined at root commands and plugin contracts

**Decision**: Generated apps continue to expose the same root commands and capability names.
Authentication remains Fabric-enabled and password-disabled, the template identity remains `universal-app`, and existing plugin create/validate/deploy tool contracts remain unchanged.
Previously generated flat Universal Apps remain valid; the plugin validator supports their existing layout while adding workspace support.

**Rationale**: The migration changes the newly generated directory layout, not the meaning of existing apps or plugin tools.
A compatibility window avoids forcing already generated apps to restructure.

**Alternative considered**: Require all apps to migrate before validation.
That would turn an internal template evolution into a breaking deployment gate.

### D10: Scaffolding customizes only the root app identity

**Decision**: The generic template customizer continues to replace only the root `package.json` name with the user-derived app directory name.
The member package names remain `@rayfin-app/frontend`, `@rayfin-app/data`, `@rayfin-app/shared`, and, when applied, `@rayfin-app/functions`.
Cross-package dependency keys and import specifiers continue to reference those stable names and are not rewritten during scaffolding.

**Rationale**: Member names are internal workspace coordinates, not user-facing app identities.
Keeping them stable avoids a broad text-substitution pass across manifests, TypeScript imports, scripts, lockfiles, pack assets, and generated declarations.
It also keeps the shared `rayfin init` template customizer unchanged: the existing root-manifest rename remains sufficient and no Universal App-specific recursive renaming behavior enters generic scaffolding.

**Alternative considered**: Derive every member name from the app name.
That would require syntax-aware rewrites across multiple file types or unsafe global string replacement, increasing collision and partial-rename risk without improving the Builder workflow.

## Risks / Trade-offs

- **Policy scans the wrong manifest set** → Discover members only from the root npm `workspaces` declaration, reject unreadable declared members, and test root and member evidence separately.
- **Local linking changes committed template files** → Perform rewrites only in an ephemeral harness target and assert the committed `template/` tree remains unchanged.
- **Plugin accidentally bundles the harness or generated target** → Resolve the source path explicitly to `samples/universal-app/template` and characterize the bundled identity and exclusions.
- **Service build commands run from the wrong directory** → Keep commands package-local and validate their effective `cwd` through the existing workspace path contract.
- **Functions appears enabled without a package** → Keep it disabled in the base, make the pack create the package before enabling it, and test both pre-pack absence and post-pack application.
- **Root personalization leaves inconsistent member references** → Keep stable `@rayfin-app/*` member names and assert scaffolding changes only the root package name.
- **Flat apps regress under workspace-aware validation** → Retain the no-workspaces fallback and run existing flat fixtures alongside new workspace fixtures.
- **The harness validates published packages instead of the branch** → Assert that every Rayfin dependency in the generated target resolves to a local repository package before build.

## Migration Plan

1. Add the OpenSpec contract and passing characterization tests for current flat-layout assumptions.
2. Introduce the outer harness and move the current Builder-facing tree under `template/` without changing plugin behavior.
3. Split frontend, data, and shared package ownership; add npm workspace orchestration and service paths.
4. Move published dependency ranges into inner package manifests and add outer-target local SDK linking.
5. Update the functions capability pack to create `packages/functions` and compose workspace scripts.
6. Update plugin bundling, policy, capability detection, artifact checks, and fixtures for the inner workspace.
7. Run harness, plugin, template, CLI path, lint, and docs validation before removing obsolete flat-layout transformations.

Rollback keeps previously generated apps unaffected.
Before release, the repository can revert the sample and plugin bundler together because no persisted service or deployment state is migrated.

## Open Questions

None for implementation.
The package boundaries, functions opt-in behavior, identity owner, dependency strategy, and compatibility window are fixed by this design.
