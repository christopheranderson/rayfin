## Pre-flight

- [x] Loaded `.github/skills/rayfin-cli-ux/SKILL.md`. Cite one rule applied: R11, preserve descriptions for every existing command, option, and argument because this migration adds no CLI surface.
- [x] Loaded `.github/skills/rayfin-cli-ux/references/cli-ux-guidelines.md`. Cite one section: Output Mode System, whose interactive, plain, and JSON contracts remain unchanged.
- [x] Every new/changed command, option, argument has a `.description()` (R11).
- [x] Every `❌` error has a recovery hint (R3).
- [x] All three output modes covered in scenarios (R1).
- [x] Destructive ops gated on `--force` (R4).
- [x] Non-interactive behavior preserved (R5).
- [x] `dev` vs `up` topology rules respected if adding lifecycle commands.

## 1. Characterization baseline

- [x] 1.1 Characterize the current Copilot plugin bundle source, post-copy identity stamping, and `workspace:*` to published Rayfin range conversion.
- [x] 1.2 Characterize that current plugin dependency policy and manifest-derived capability detection read the flat root manifest rather than nested package manifests.
- [x] 1.3 Characterize the current functions capability alias, `rayfin/functions` destination, service mutation, nested install directory, and root build-script composition.
- [x] 1.4 Run the smallest Copilot plugin and Universal App template test commands covering the characterization tests.

## 2. Outer harness and inner template

- [x] 2.1 Convert `samples/universal-app` into one Rush project with clean, build, test, and local-SDK-link scripts modeled on `samples/workspace-todo-app`.
- [x] 2.2 Move the Builder-facing source of truth under `samples/universal-app/template` and keep the harness target and install output ignored.
- [x] 2.3 Make the harness prepare an ephemeral target, rewrite only Rayfin dependencies to local repository packages, and assert the committed template tree is unchanged.
- [x] 2.4 Update Rush project output settings so build caching tracks harness output without treating the inner template as generated content.

## 3. Inner npm workspace

- [x] 3.1 Add root npm workspace orchestration, preserve existing root commands, and keep user-derived app-name customization limited to the root manifest.
- [x] 3.2 Move Vite, React, authentication, UI, and browser-only dependencies into `packages/frontend` named `@rayfin-app/frontend`.
- [x] 3.3 Move Rayfin entity registration and data schema exports into `packages/data` named `@rayfin-app/data`.
- [x] 3.4 Add `packages/shared` named `@rayfin-app/shared` for isomorphic contracts and wire member references with `*`.
- [x] 3.5 Apply the established browser-only, Node.js-only, and isomorphic TypeScript role profiles from the prior workspace-support design.
- [x] 3.6 Update `rayfin/rayfin.yml` so data and static hosting use package paths and package-local build commands.
- [x] 3.7 Replace inner `workspace:*` and repository-relative dependencies with supported published Rayfin ranges while preserving pinned non-Rayfin capability dependencies.

## 4. Capability packs

- [x] 4.1 Retarget frontend-owned pack copies and seed digests to `packages/frontend` while preserving customized-file protection.
- [x] 4.2 Update the functions pack to create `packages/functions` named `@rayfin-app/functions`, set its service path and build command, and compose the workspace package build into root commands.
- [x] 4.3 Replace nested functions dependency installation with the npm workspace install flow and update successful-install markers accordingly.
- [x] 4.4 Add template tests for pre-pack functions absence, post-pack package creation, canonical alias recording, idempotency, and authored-file preservation.
- [x] 4.5 Run all Universal App pack and kit type-check tests against the inner template.

## 5. Copilot plugin workspace support

- [x] 5.1 Change the plugin bundler to copy `samples/universal-app/template` and verify the committed identity instead of stamping it.
- [x] 5.2 Remove inner-template `workspace:*` conversion and retain local range resolution only for plugin-owned test fixtures that require it.
- [x] 5.3 Discover manifests from the root npm workspaces declaration and fail closed for missing or malformed declared members.
- [x] 5.4 Validate required and pinned dependencies across root and member manifests while keeping identity, lifecycle-script, root-command, and `rayfinPacks` policy rooted at the workspace manifest.
- [x] 5.5 Detect manifest-derived capabilities across workspace members and resolve entity evidence from the configured data service path.
- [x] 5.6 Preserve flat-app fallback behavior in policy, capability detection, render-path analysis, and data schema discovery.
- [x] 5.7 Update artifact checks, fixtures, bundle budgets, and source-identity assertions for the two-layer layout.
- [x] 5.8 Keep the generic template customizer root-only and add assertions that app personalization does not rename stable member packages or cross-package references.

## 6. E2E Tests

- [x] 6.1 Scenario: clean Universal App workspace generation and validation.
  Location: `samples/universal-app/`.
  Trigger: run the Rush build and test scripts that prepare the inner template target.
  Preconditions: repository dependencies installed; no target directory; no Fabric authentication or network deployment required.
  Observable outcome: local Rayfin SDKs are linked only in the target; root build, type-check, lint, and test commands succeed; the committed template is unchanged.
  Cleanup: remove the generated target and its npm install output.
- [x] 6.2 Scenario: Copilot plugin creates and validates the bundled workspace template.
  Location: `packages/tools/copilot-plugin/tests/rayfin.test.ts`.
  Trigger: scaffold from the vendored template and run plugin validation in interactive, plain, and JSON host modes.
  Preconditions: plugin template bundle built from the inner source; process executor uses deterministic local fixtures; no Fabric deployment.
  Observable outcome: identity, policy, build, type-check, lint, and test gates succeed with unchanged tool result schemas in all modes; the root package is personalized while `@rayfin-app/*` member names remain stable.
  Cleanup: remove generated temporary app directories.
- [x] 6.3 Scenario: non-interactive workspace validation failure is recoverable.
  Location: `packages/tools/copilot-plugin/tests/rayfin.test.ts`.
  Trigger: validate a workspace whose declared member manifest is missing and whose execution environment is non-interactive.
  Preconditions: authenticated root config fixture with one invalid workspace member; no package scripts executed.
  Observable outcome: validation fails closed, identifies the member, emits the existing structured failure shape, and provides the host's recovery guidance without prompting.
  Cleanup: remove the temporary fixture.
- [x] 6.4 Scenario: functions capability remains opt-in.
  Location: `samples/universal-app/scripts/scaffold.integration.test.mjs`.
  Trigger: inspect a fresh target, then run `npm run pack:add -- functions --no-install`.
  Preconditions: inner template copied to a temporary directory; pack assets available; no registry access.
  Observable outcome: functions is absent and disabled before the trigger, then `packages/functions` exists, the service path and build command are configured, root scripts include its build, and a second application preserves authored files.
  Cleanup: remove the temporary app directory.
- [x] 6.5 Scenario: existing flat app remains compatible.
  Location: `packages/tools/copilot-plugin/tests/rayfin.test.ts`.
  Trigger: validate the existing flat Universal App fixture after workspace-aware policy is enabled.
  Preconditions: fixture has no `workspaces` declaration and uses the supported root dependency ranges.
  Observable outcome: policy and capability detection use the flat fallback and return the same validation result and exit semantics as before the migration.
  Cleanup: fixture is read-only; remove any generated deployment registry material.

## 7. User-Facing Documentation

- [x] 7.1 Assess documentation impact: user-facing because generated Universal Apps expose a new package layout while preserving their root workflow.
- [x] 7.2 Update `samples/universal-app/template/README.md` to explain the root commands, frontend, data, shared, and opt-in functions package boundaries.
- [x] 7.3 Update `packages/guide/assets/docs/getting-started/project-structure.md` with the Universal App workspace layout and service-path relationship.
- [x] 7.4 Update `packages/guide/assets/docs/cli/templates.md` only if Universal App distribution wording could imply it is selectable through `rayfin init`; keep the plugin-only boundary explicit.
- [x] 7.5 Run `rush docs:lint` and `cd docs/site && rushx build`.

## 8. Final verification

- [x] 8.1 Run targeted Universal App harness, Copilot plugin, template, and CLI workspace-path tests.
- [x] 8.2 Run package type-check, lint, and artifact checks for every changed project.
- [x] 8.3 Confirm `git status` contains no generated targets, vendored install output, or modified committed template manifests.
- [x] 8.4 Verify the OpenSpec change and confirm every requirement has direct automated coverage or a documented manual deployment validation.

### Final requirement traceability

| Requirement | Direct automated coverage |
| --- | --- |
| Universal App uses a two-layer sample structure | Harness build/test lifecycle and `bundle-template.test.ts` source/exclusion assertions |
| Base workspace has explicit package boundaries | Harness workspace assertions and template scaffold integration tests |
| Member package names remain stable during scaffolding | Plugin scaffold personalization E2E and functions-pack personalization tests |
| Functions remains an opt-in package | Functions contract and scaffold integration tests, including offline root workspace install/build/test |
| Service configuration addresses workspace packages | Harness service assertions, functions-pack tests, and CLI workspace-path tests |
| Inner workspace uses distributable dependency specifications | Bundle, artifact, local-link, and template-immutability tests |
| Copilot plugin preserves template identity without stamping it | Bundle identity success/failure and outer-harness exclusion tests |
| Plugin policy is workspace-aware and fails closed | Plugin policy tests for member ownership, malformed/missing members, conflicts, ranges, and flat fallback |
| Capability detection follows package and service evidence | Plugin member/pack capability and configured data-package entity tests |
| Generated app and plugin contracts remain compatible | Three-mode scaffold/validation E2E, root command harness tests, and legacy flat-app E2E |
| Migration is verified across source, bundle, pack, and validation surfaces | Clean harness, complete template suite, plugin `check`, CLI suite, docs build/lint, and repository checks |

All requirements have direct automated coverage.
No live Fabric deployment validation is required because deployment behavior is explicitly unchanged by this migration.
