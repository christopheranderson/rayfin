## ADDED Requirements

### Requirement: Todo data entity with user ownership
The system SHALL provide a `Todo` entity with fields: `id` (uuid), `title` (text), `isCompleted` (boolean), `createdAt` (date), and `user_id` (text). The entity SHALL enforce user ownership via a DAB policy that restricts access to todos where `claims.sub` equals `item.user_id`.

#### Scenario: Todo entity enforces user isolation
- **WHEN** a user queries todos via the data API
- **THEN** only todos where `user_id` matches the authenticated user's `sub` claim are returned

#### Scenario: Todo entity supports CRUD operations
- **WHEN** a user creates, reads, updates, or deletes a todo
- **THEN** the operation succeeds only for todos owned by the authenticated user

### Requirement: Fabric Entra authentication only
The system SHALL support Fabric Entra authentication as the sole authentication method. The `rayfin.yml` configuration SHALL set `auth.password.enabled: false` and `auth.fabric.enabled: true`. The UI SHALL render only the Fabric sign-in button on the auth page.

#### Scenario: Auth page shows Fabric sign-in only
- **WHEN** an unauthenticated user visits the app
- **THEN** the auth page displays only a Fabric Entra sign-in button with no username/password form

#### Scenario: Fabric Entra auth callback
- **WHEN** a user completes Fabric Entra sign-in and is redirected back
- **THEN** the app processes the OAuth callback and establishes an authenticated session

### Requirement: Milestone task seeding on first sign-in
The system SHALL seed the user's todo list with predefined milestone tasks when the user has zero existing todos after signing in. The seeded tasks SHALL be: "Create app with database" (completed), "Publish app" (completed), and "Describe the app you want to build to the VS Code chat" (not completed).

#### Scenario: First sign-in seeds milestone tasks
- **WHEN** a user signs in for the first time and has zero todos
- **THEN** three milestone tasks are created automatically with the correct completion states

#### Scenario: Returning user sees no duplicate seeds
- **WHEN** a user who already has todos signs in
- **THEN** no additional milestone tasks are created

### Requirement: Todo list UI with Tailwind and shadcn components
The system SHALL display todos in a list using shadcn/Radix UI components styled with Tailwind CSS v4. Each todo item SHALL show its title with a checkbox for completion status. The UI SHALL include a text input for adding new todos and allow toggling completion and deleting todos.

#### Scenario: User views todo list
- **WHEN** a signed-in user visits the dashboard
- **THEN** their todos are displayed in a styled list with checkboxes and delete actions

#### Scenario: User adds a new todo
- **WHEN** a user types a title and submits the new todo form
- **THEN** a new todo is created via the data API and appears in the list

#### Scenario: User toggles todo completion
- **WHEN** a user clicks the checkbox on a todo item
- **THEN** the todo's `isCompleted` status is toggled via the data API

#### Scenario: User deletes a todo
- **WHEN** a user clicks the delete action on a todo item
- **THEN** the todo is removed via the data API and disappears from the list

### Requirement: Production-first documentation
The README.md SHALL lead with the production deployment workflow: deploy with `npx rayfin up`, then develop locally against the production backend with `npm run dev:prod`. Local-only development (`npm run dev` + `npm run rayfin:dev`) SHALL be documented as a secondary alternative. The AGENTS.md SHALL follow the same production-first ordering in its quickstart and command table.

#### Scenario: README leads with production workflow
- **WHEN** a builder reads the README Getting Started section
- **THEN** the first documented workflow is deploy with `rayfin up` followed by `npm run dev:prod`

#### Scenario: Local development documented as alternative
- **WHEN** a builder reads past the primary workflow
- **THEN** local development with `npm run rayfin:dev` + `npm run dev` is documented as a secondary option

### Requirement: Template registration in create-rayfin
The template SHALL be registered in the `create-rayfin` package so that builders can scaffold it via `npm create @microsoft/rayfin my-app --template getting-started-auth`. The template's `package.json` SHALL include a `template` metadata field with `name`, `displayName`, and `description`.

#### Scenario: Template is scaffoldable via CLI
- **WHEN** a builder runs `npm create @microsoft/rayfin my-app --template getting-started-auth`
- **THEN** the CLI creates a new project from the getting-started-auth template

### Requirement: Welcome page with journey milestones
The dashboard SHALL display a welcome section with the heading "Welcome to your app" and a "Your journey so far" card showing milestone tasks synced from the database. Completed milestones SHALL display with a green check icon. The uncompleted milestone SHALL have an input-style appearance with a blue border.

#### Scenario: Dashboard shows welcome and milestones
- **WHEN** a signed-in user visits the dashboard
- **THEN** a welcome heading and milestone card are displayed above the todo list
