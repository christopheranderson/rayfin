---
applyTo: '**/*.ts'
---

# Rayfin TypeScript Editing Instructions

## Decorators And Configuration

- Use modern TC39 Stage 3 decorators; do not enable legacy `experimentalDecorators`.
- Extend the shared `packages/tsconfig.base.json` in each TypeScript package.
- Ensure the `lib` array includes `ESNext.Decorators`.
- Ensure `importHelpers` is `false` so no `tslib` helpers are emitted.
- When you see the error `This syntax requires an imported helper but module 'tslib' cannot be found`, fix it by setting `importHelpers: false` in the closest `tsconfig.json`.

For decorator behavior and DAB-specific shapes, also consult:

- `packages/typescript-sdk/core/AGENTS.md` for decorator design and patterns.
- `.github/instructions/rayfin-data.instructions.md` for DAB-compliant query shapes and serialization rules.

## Coding Standards

- Enable strict TypeScript settings and keep ES2024+ syntax with bundler-style module resolution (match `packages/tsconfig.base.json`).
- Use relative imports without `.js` extensions inside the repo.
- Prefer readable, well-documented public APIs and keep runtime behavior simple, especially in decorator-heavy code.
