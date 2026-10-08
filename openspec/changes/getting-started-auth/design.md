## Context

The Rayfin platform provides several sample templates for getting started, including `welcome-app-react-auth` (Tailwind/shadcn UI with auth and timestamps) and `todo-app` (full-featured todo management with mock/Rayfin mode switching). Neither template focuses on the production-first workflow where builders deploy to Fabric and iterate with `rayfin up`.

The `getting-started-auth` template combines the UI polish of `welcome-app-react-auth` (Tailwind CSS v4, shadcn/Radix components) with practical todo functionality, while driving a production-first development experience.

## Goals / Non-Goals

**Goals:**

- Create a new sample template that teaches builders the production deployment workflow (`rayfin up` + `npm run dev:prod`).
- Provide a practical todo-app experience with Tailwind CSS v4 and shadcn UI components.
- Support Fabric Entra authentication only (no username/password).
- Seed the app with milestone tasks that guide the builder journey.
- Register the template in `create-rayfin` for scaffolding.

**Non-Goals:**

- Categories, profile images, or storage integration (keep it simple for onboarding).
- Mock mode / service switching (Rayfin-only, no localStorage fallback).
- Username/password or magic-link authentication.
- E2E test infrastructure (this is a getting-started template, not a test reference).
- PostgreSQL support (MSSQL dialect only, matching `welcome-app-react-auth`).

## Decisions

### 1. Copy `welcome-app-react-auth` as base, not `todo-app`

**Rationale:** The `welcome-app-react-auth` template already has Tailwind v4, shadcn/Radix UI components, and the Rayfin-only service pattern we want. The `todo-app` uses Tailwind v3, has no shadcn, and has the mock/Rayfin switching complexity we don't need. It's simpler to copy `welcome-app-react-auth` and replace the Timestamp entity/UI with Todo functionality than to retrofit `todo-app` with shadcn.

**Alternatives considered:** Starting from `todo-app` and adding shadcn — rejected because the todo-app has mock mode plumbing, PostgreSQL config, storage integration, and category/profile-image features that would all need to be stripped out.

### 2. Simplified Todo data model (no categories or relationships)

**Rationale:** The goal is onboarding, not showcasing all Rayfin features. A flat Todo entity with `id`, `title`, `isCompleted`, `createdAt`, and `user_id` is sufficient to demonstrate data operations and user ownership. Builders can always reference the full `todo-app` for advanced patterns.

### 3. Fabric Entra authentication only

**Rationale:** The production-first workflow requires a deployed backend. Username/password auth is a local-dev convenience that doesn't apply when targeting production. Removing it simplifies the auth flow and code, and aligns with the template's purpose of teaching production deployment. For local development the builder will still need `npm run dev` with `rayfin dev` running locally, but the primary workflow documented is `npm run dev:prod` against a production backend.

### 4. Seeded milestone tasks

**Rationale:** Showing pre-populated tasks on first sign-in provides immediate visual feedback and guides the builder through the Rayfin journey. Tasks are seeded via the Rayfin data service on first load when the user has zero todos. The milestone tasks match the screenshot: "Create app with database" (completed), "Publish app" (completed), "Describe the app you want to build to the VS Code chat" (not completed).

### 5. Production-first documentation

**Rationale:** README.md and AGENTS.md will lead with `rayfin up` and `npm run dev:prod` as the primary workflow. Local development (`npm run dev` + `rayfin dev`) is documented as a secondary option. This inverts the typical order to emphasize the platform's deployment story.

## Risks / Trade-offs

- [Fabric-only auth limits local dev] → Builders can still use `npm run dev` + `rayfin dev` for full local development, but the README leads with production workflow. Auth on local will use Fabric redirect through the deployed backend.
- [Simplified data model may feel too basic] → The template links to the full `todo-app` sample for builders who want more features. The simplicity is intentional for onboarding.
- [Seed data relies on client-side detection] → If the seed logic fails or runs multiple times, it could create duplicate milestone tasks. Mitigation: seed only when user has exactly zero todos, and use deterministic IDs or titles to detect existing seeds.
