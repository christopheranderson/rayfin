# Todo App

A Rayfin-enabled todo application that demonstrates clean service-based architecture, React hooks, and Rayfin auth/data/storage integration.

## Overview

This sample shows how to:
- Build a React + TypeScript todo app with mock services.
- Switch to Rayfin-backed services (auth, todos, categories, profile images) without changing UI code.
- Configure the app via environment variables and run Rayfin CLI workflows for local development.

This README is Contributor-focused.
For Contributor and automation details, see `AGENTS.md` in this folder and `/docs/contributor/todo-app.md`.

## Prerequisites

To run the sample end to end you will need:
- Node.js 20.13.0 or later.
- @microsoft/rush installed globally.
- Docker Desktop (for running the Rayfin backend container).

## Quick Start (Mock Mode)

Use mock services when you want to explore the UI without any backend.

1. Install dependencies:
   - Run `rush install`.
2. Start the todo app in mock mode:
   - Run `rushx dev:mock`.
3. Open the app:
   - Navigate to the URL Vite returns (e.g., `http://localhost:5173`) in your browser.

### Demo Users (Mock Mode)

In mock mode you can sign in with any of these users (password is always `password123`):
- `alice@example.com`
- `bob@example.com`
- `charlie@example.com`

Mock mode uses in-memory data persisted to `localStorage`. No backend is required.

## Full Stack (Rayfin Mode)

Rayfin mode uses the Rayfin platform for authentication, data, and storage. You can create real users, manage todos through Rayfin’s Data API, and store profile images in Rayfin storage.

### 1. Start the Rayfin backend with Docker

Start the Rayfin backend and supporting services:
- Run `rushx rayfin:up`.

This command uses the Rayfin CLI to:
- Start the Rayfin host in Docker.
- Apply the data and storage configuration for this sample.
- Expose the Rayfin web service on a URL provided in the command's logs, defaulting to `http://localhost:5168`.

### 2. Start the todo app in Rayfin mode

With the backend running, start the frontend:
- Run `rushx dev:rayfin`.

This command:
- Switches the app to Rayfin service mode.
- Starts the Vite dev server.

Open `http://localhost:5173` and sign up as a new user. All authentication, todos, categories, and profile images are now backed by Rayfin.

## Service Modes

The app has two service modes controlled by an environment variable.

### Modes

- **Mock** (`mock`)
   - Uses mock services backed by `localStorage`.
   - No backend required.
   - Ideal for quick UI exploration and offline demos.

- **Rayfin** (`rayfin`)
   - Uses the Rayfin client for auth, data, and storage.
   - Requires the Rayfin backend to be running.
   - Recommended when validating real Rayfin workflows.

### Mode commands

From `samples/todo-app`:
- `rushx dev:mock` – start the app in mock mode.
- `rushx dev:rayfin` – start the app in Rayfin mode and apply the schema.
- `rushx dev` – start the app using whatever mode is currently configured.

You can also toggle the mode explicitly without starting the dev server:
- `rushx toggle-mode` – toggles between `mock` and `rayfin` by updating `.env.local`.

Changes to service mode take effect the next time you start the dev server.

## Configuration

The app is configured via Vite environment variables.
These can be set in `.env` files or on the command line.

The Rayfin backend configuration (`rayfin.yml`) supports environment variable interpolation for managing environment-specific values.

### Rayfin configuration with environment variables

The `rayfin.yml` file supports Docker Compose-style variable interpolation:
- `${VAR}` – Simple variable substitution.
- `${VAR:-default}` – Substitution with default value.

Example:

```yaml
# rayfin.yml
services:
  data:
    connectionString: Server=${DB_HOST:-localhost};Port=${DB_PORT:-5432}
  auth:
    issuer: ${AUTH_ISSUER}
```

```bash
# rayfin/.env
DB_HOST=production-db.example.com
DB_PORT=5432
AUTH_ISSUER=https://auth.example.com
```

See `rayfin/.env.example` for a list of supported variables.

You can specify a custom `.env` file path with the `--env-file` option:

```bash
rushx rayfin:up --env-file staging.env
```

Or set the `RAYFIN_ENV_FILE` environment variable:

```bash
export RAYFIN_ENV_FILE=production.env
rushx rayfin:up
```

For more details, see the [Environment Variable Interpolation](../../packages/guide/assets/docs/cli/env-interpolation.md) documentation.

### Frontend environment variables

`rayfin dev` generates frontend variables in `.env.local` before starting the Vite child process.
The source of truth is `rayfin/.env` using the `RAYFIN_PUBLIC_*` prefix.

- `VITE_RAYFIN_API_URL`
   - Base URL for the Rayfin web service.
   - Default: `http://localhost:5168`.
   - Sourced from `RAYFIN_PUBLIC_API_URL` in `rayfin/.env`.

- `VITE_RAYFIN_PUBLISHABLE_KEY`
   - Rayfin publishable key used for client authentication.
   - Sourced from `RAYFIN_PUBLIC_PUBLISHABLE_KEY` in `rayfin/.env` (populated by `rayfin up`).

- `VITE_FABRIC_ITEM_ID`
   - Rayfin item ID set by `rayfin up`.
   - Optional; used for managed hosting scenarios.
   - Sourced from `RAYFIN_PUBLIC_ITEM_ID` in `rayfin/.env`.

- `VITE_SERVICE_MODE`
   - Controls which service implementation is used: `mock` or `rayfin`.
   - Default: `rayfin` in `.env`.
   - Overridden by `.env.local` and scripts like `rushx dev:mock` / `rushx dev:rayfin`.

### Env files

The sample uses standard Vite env files plus the Rayfin env directory:

- `.env` – shared defaults for all environments (checked in).
- `.env.local` – generated by `rayfin env --framework vite` (git-ignored).
- `rayfin/.env` – runtime and deployment values (git-ignored, written by `rayfin up`).
- `rayfin/.deployments.json` – registry of Fabric workspace deployments (written by `rayfin up`; not required for local dev).

To override a value, edit `rayfin/.env` and re-run `npm run dev`.

Example `rayfin/.env` to force a custom backend URL:

```bash
RAYFIN_PUBLIC_API_URL=http://localhost:8080
```

The `rushx toggle-mode` script updates `VITE_SERVICE_MODE` in `.env.local` for you.

## Architecture

The todo app is organized around a service container that can swap mock and Rayfin-backed implementations without changing the UI.

### High-level structure

```text
src/
├── models/           # Domain models (User, Todo, Category)
├── services/         # Service layer
│   ├── interfaces/   # Service contracts
│   ├── mock/         # Mock implementations (localStorage)
│   └── rayfin/       # Rayfin implementations (auth/data/storage)
├── hooks/            # React hooks (auth, todos, categories, profile image)
├── components/       # UI components
└── __tests__/        # Tests and test setup
```

### Service container

The `ServiceContainer` class wires up the correct services for the current mode:
- In **mock** mode it provides:
   - Mock auth service with demo users.
   - Mock todo and category services stored in `localStorage`.
   - Mock profile image service storing images in `localStorage`.
- In **Rayfin** mode it provides:
   - Rayfin auth service using `@microsoft/rayfin-client`.
   - Rayfin todo and category services using Rayfin’s Data API.
   - Rayfin profile image service using storage composed through `@microsoft/rayfin-client/experimental` and `@microsoft/rayfin-storage`.

The rest of the app (hooks and components) depends only on the service interfaces, not on the concrete implementations.

### Hooks

Key React hooks that drive the UI:
- `useAuth` – exposes `user`, `isAuthenticated`, `login`, `logout`, and `signup`.
- `useTodos` – loads and mutates todos, applies category filters, and exposes loading/error state.
- `useCategories` – manages categories (create, update, delete) and exposes a category list.
- `useProfileImage` – loads the current profile image, validates uploads, and pushes updates.

These hooks use the `ServiceContainer` under the hood and work in both mock and Rayfin modes.

### Components

Some important components:
- `App` – top-level layout that chooses between auth and todo views based on auth state.
- `AuthPage`, `LoginForm`, `SignupForm` – auth flow components.
- `TodoList`, `TodoItem`, `TodoForm` – todo list UI and CRUD flows.
- `CategoryManager`, `CategoryFilter`, `CategoryBadge` – category management and filtering.
- `ProfileImage`, `ProfileImageUpload`, `ProfileImageModal` – profile image selection, upload, and preview.

All of these components are agnostic to whether services are mock or Rayfin-backed.

## Rayfin Integration

This sample demonstrates how to integrate a React app with the Rayfin platform.

### Rayfin client

- A singleton `RayfinClientService` manages the underlying `RayfinClient` instance.
- The client is initialized once in Rayfin mode using the `VITE_RAYFIN_API_URL` environment variable.
- A helper function `getRayfinClient()` returns the singleton client for services that need it.

### Authentication

In Rayfin mode:
- `RayfinAuthService` uses `client.auth` to:
   - Sign up new users.
   - Sign in existing users.
   - Sign out and clear the session.
   - Read the current session and user.
- `AuthStateObserver` subscribes to `client.auth.onAuthStateChange` and keeps React auth state in sync.

In mock mode:
- A mock auth service provides demo users backed by `localStorage`.

### Todos and categories

In Rayfin mode:
- `RayfinTodoService` uses Rayfin’s fluent Data API to:
   - List todos for the current user.
   - Create, update, and delete todos.
   - Include related category information when fetching todos.
- `RayfinCategoryService` uses Rayfin Data to manage categories for the current user.

In mock mode, equivalent services use in-memory data persisted to `localStorage`.

### Profile images

In Rayfin mode:
- `RayfinProfileImageService` uses Rayfin storage to:
   - Upload profile image files with validation (size and type).
   - Fetch the latest stored image and convert it to a data URL for display.

In mock mode, profile images are stored and loaded from `localStorage`.

For more detail on how Rayfin client and data are used, see `AGENTS.md` in this folder.

## Development and Testing

Common development commands from `samples/todo-app`:

- `rushx dev:mock` – start the dev server in mock mode.
- `rushx dev:rayfin` – start the dev server in Rayfin mode and apply schema.
- `rushx dev` – start the dev server using the currently configured mode.
- `rushx build` – run the TypeScript build (used by the monorepo build).
- `rushx preview` – preview a production Vite build.
- `rush test -i todo-app` – run tests once using Vitest.
- `rushx test:watch` – run tests in watch mode.
- `rushx coverage` – run tests with coverage.

### End-to-End Tests

The todo-app includes comprehensive end-to-end tests covering both API and UI functionality.

**Prerequisites:**
- Rayfin backend running (via `rushx rayfin:up:local`)
- Playwright browsers installed: `npx playwright install --with-deps chromium`

**Run all E2E tests:**

```bash
rushx test:e2e
```

**Run individual test suites:**

```bash
rushx test:e2e:api       # API tests only
rushx test:e2e:api:core  # API tests without email
rushx test:e2e:api:email # API tests with email
rushx test:e2e:ui        # UI tests only (Playwright)
```

**Testing with different database dialects:**

The todo-app supports testing with different database dialects using the `DATA_DIALECT` environment variable.
The dialect must be set before starting the backend:

```bash
# Test with MSSQL (default)
rushx rayfin:up:local
rushx test:e2e

# Test with PostgreSQL
DATA_DIALECT=postgresql rushx rayfin:up:local
rushx test:e2e
```

**Note:** The backend must be purged and then setup again when changing dialects.

## Troubleshooting

### The app cannot connect to the backend

If you see errors when running `rushx dev:rayfin`:
- Make sure the Rayfin web service is running on `http://localhost:5168`.
- Check that `RAYFIN_PUBLIC_API_URL` in `rayfin/.env` matches the backend URL and re-run `npm run dev`.
- If `rayfin db apply` fails with a message about `force`, run `npx rayfin db apply --force` from `samples/todo-app`, then retry `rushx dev:rayfin`.

If connectivity or CORS issues occur at runtime, the app may automatically fall back to mock mode to keep the UI usable.

### I only see the login screen

This is expected when you are not authenticated.
- In mock mode, use one of the demo users listed above.
- In Rayfin mode, click **Sign up** to create a new account backed by Rayfin.

## Contributing

This README targets app Contributors. If you want to change the sample itself or automate it in CI, see:
- `AGENTS.md` in this folder for agent and Contributor guidance.
- `/docs/contributor/README.md` for Rayfin contributor documentation.

## License

This project is licensed under the terms of the root `LICENSE` file in the repository.
