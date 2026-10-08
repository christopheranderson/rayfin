# TypeScript SDK Agent Instructions

This directory contains the TypeScript/Node.js SDK packages (`@microsoft/rayfin-*`) published for Builders.

## Components

- **@microsoft/rayfin-core**: Core decorators and metadata for code-first DAB configuration generation. See [AGENTS.md](./core/AGENTS.md)
- **@microsoft/rayfin-data**: DAB-compliant data client for REST and GraphQL access patterns. See [AGENTS.md](./data/AGENTS.md)
- **@microsoft/rayfin-lib**: Shared HTTP and client utilities used by higher-level Rayfin SDKs.
- **@microsoft/rayfin-auth**: Authentication helpers and client-side auth utilities built on `rayfin-lib`.
- **@microsoft/rayfin-client**: High-level client entrypoint for auth and data APIs, with experimental service composition support.
- **@microsoft/rayfin-functions**: TypeScript helpers for function-style workflows on top of Rayfin core.
- **@microsoft/rayfin-storage**: Type-safe blob storage client for Rayfin storage backends. See [AGENTS.md](./storage/AGENTS.md)

## Development

- **Install dependencies**: Run `rush update --subspace default` from the repo root to install or refresh SDK dependencies.
- **Dependency management**: Use `rush add -p <package>` or `rush remove -p <package>` for changes. Do not use `npm`, `pnpm`, or `yarn` directly inside the monorepo.
- **Build**: Use `rush build --to <project>` to build specific SDK packages, or `rushx build` from a package directory.
- **Test**: Use `rush test --to <project>` for targeted tests, or `rushx test` and related scripts (for example, `rushx test:watch`, `rushx test:integration`) from package directories.
- **Coverage (repo-wide)**: Use `rush test:coverage` from the repo root to generate coverage reports for all packages.
- **Coverage (single package)**: From a package directory, prefer `rushx test:coverage`.
  `test:coverage` scripts may include required flags (for example `--coverage.reporter=text`) to ensure a text summary is printed.
  If the package does not define `test:coverage`, use `rushx test -- --coverage --coverage.reporter=text`.
- **Lint and format**: Use `rush lint` and `rush format` at the repo level. Some packages also expose `rushx lint`.
- **Generated outputs**: All SDK packages compile from `src/` to `dist/` and emit `.tsbuildinfo` files. Treat `dist/` and `*.tsbuildinfo` as generated build artifacts, not hand-edited sources.
- **Adding a new SDK package**: After scaffolding, add its directory to `entryPoints` in [common/config/typedoc/typedoc.lint.json](../../common/config/typedoc/typedoc.lint.json) so `rush lint` validates its TSDoc. See [common/config/typedoc/AGENTS.md](../../common/config/typedoc/AGENTS.md).

## Public API documentation

Everything re-exported from a package's `src/index.ts` is part of the Builder-facing surface and must carry TSDoc written for SDK consumers — not for Rayfin contributors. In particular:

- Every public class, interface, type, function, constant, and decorator needs a Builder-facing TSDoc comment. Prefer `@example` for non-trivial APIs.
- Do **not** reference internal helpers, non-exported types, internal module paths (`_internal/...`, `dist/...`), internal env vars / feature flags / secrets / endpoints, or contributor-only notes in public TSDoc.
- If a symbol is exported only for cross-package wiring, tests, or other contributor-only consumers, tag it `@internal` so it is stripped from the documented surface (the lint config sets `excludeInternal: true`).

Full rules and examples: [common/config/typedoc/AGENTS.md](../../common/config/typedoc/AGENTS.md#public-api-documentation-requirements).

## Deprecations

When deprecating any SDK API, you **must** use the shared deprecation utility from `@microsoft/rayfin-lib` (`lib/src/deprecation.ts`).
Do **not** hand-roll a `console.warn`, and do **not** add one-off "has warned" boolean flags.

The utility is cross-environment: `@microsoft/rayfin-lib` runs in browsers, Node, and workers, so it does **not** use Node's `util.deprecate` or `process.emitWarning`.
It emits through `console.warn` behind a guarded check and never throws.

Available helpers (exported from the package index):

- `deprecate(code, message, options?)` — emit a warning at a consumption site (for example, where a deprecated config field is read); warns once per stable `code`.
- `deprecateFn(fn, code, message, options?)` — a `util.deprecate`-style wrapper for a deprecated function or method; warns on call and preserves arguments, `this`, and the return value.
- `deprecateField(obj, key, code, message, options?)` — replace a deprecated property on an object the SDK owns with an accessor that warns on get and set.
- `setDeprecationsSilenced(silenced)` / `isDeprecationSilenced()` — programmatically silence or query deprecation warnings.

Key behaviors:

- Each `code` warns at most once (dedupe via a module-level `Set<string>`); pass `{ once: false }` to warn on every call.
- Messages are formatted as `[rayfin] <message> [<code>]` so warnings are greppable and filterable by code.
- Silencing is controlled by the `setDeprecationsSilenced()` programmatic toggle (which takes precedence) or the guarded `RAYFIN_NO_DEPRECATION` environment variable (`1` or `true`, case-insensitive).

Conventions:

- Use a stable, screaming-snake-case `code` prefixed with `RAYFIN_DEP_` (for example, `RAYFIN_DEP_USE_PROXY`).
- Pair every runtime deprecation with a `@deprecated` TSDoc tag on the public symbol so the type system and docs flag it too.

```ts
import { deprecate } from '@microsoft/rayfin-lib';

// At the consumption site, detect that the consumer set the field (not truthiness):
if (config.useProxy !== undefined) {
  deprecate(
    'RAYFIN_DEP_USE_PROXY',
    'The `useProxy` option is deprecated and no longer has any effect; remove it from your config.'
  );
}
```

See `/.github/instructions/rush.instructions.md` for Rush workflows and `/.github/instructions/ts.instructions.md` for detailed TypeScript guidelines.
