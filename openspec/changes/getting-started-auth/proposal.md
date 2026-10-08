## Why

The current `welcome-app-react-auth` template demonstrates basic authentication and timestamp tracking but does not guide users through a production-oriented workflow.
Builders need a getting-started template that teaches them to iterate against a production backend using `npm run dev:prod` and deploy with `rayfin up`, rather than relying solely on local development with `npm run dev`.
A todo-app provides a more practical and engaging starting point than timestamps, while still being simple enough for onboarding.

## What Changes

- Add a new `getting-started-auth` sample under `samples/` based on the `welcome-app-react-auth` template structure (Tailwind CSS v4, shadcn/Radix UI components).
- Replace the Timestamp entity with a simplified Todo entity (title, completed status, priority, created date) derived from the todo-app's data model. No categories or profile images.
- Remove username/password authentication support; only Fabric Entra auth is supported.
- Seed the app with initial sample tasks shown on first sign-in (e.g., "Create app with database", "Publish app", "Describe the app you want to build to the VS Code chat").
- Update AGENTS.md and README.md to drive a production-first workflow: `npm run dev:prod` as the primary development command, with `rayfin up` for deploying changes.
- Add the template to `create-rayfin`'s template list so it can be scaffolded via `npm create @microsoft/rayfin`.

## Capabilities

### New Capabilities

- `getting-started-auth-template`: New sample template with todo-app functionality, Tailwind/shadcn UI, Fabric-only auth, production-first documentation, and milestone-seeded tasks.

### Modified Capabilities

## Impact

- `samples/getting-started-auth/` — New sample directory with full app source.
- `packages/tools/create-rayfin/templates/` — New template added for scaffolding.
- `samples/README.md` — Updated to list the new sample.
- No breaking changes to existing templates or packages.
