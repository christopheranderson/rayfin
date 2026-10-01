# notes-app Specification

## Purpose

The notes-app is a sample application demonstrating Rayfin platform integration for a note-taking application with full CRUD operations, notebook organization, and authentication.
This sample serves as a reference implementation for Contributors building Rayfin-based applications, showcasing best practices for service architecture, data management, and UI patterns.

## Overview

The notes-app demonstrates:

- **Dual-mode operation**: Mock mode (localStorage) and Rayfin mode (backend API) with runtime switching
- **Service architecture**: Interface-based service layer with mock and Rayfin implementations
- **Authentication**: Email/password-based user authentication with session management
- **Data management**: Notes organized into notebooks with CRUD operations
- **GraphQL integration**: Type-safe GraphQL queries and mutations via Rayfin client
- **React patterns**: Custom hooks for state management and service integration

## Requirements

### Requirement: Authentication System

The notes-app SHALL provide user authentication supporting both mock and Rayfin backend modes.

**ID**: `REQ-NOTES-AUTH-001`

**Priority**: High

**Rationale**: Authentication is required to scope notes and notebooks to individual users and demonstrate Rayfin's authentication capabilities.

#### Scenario: User registration

**Given** a new user provides email and password
**When** the user submits the registration form
**Then** the system SHALL create a new user account
**And** SHALL authenticate the user
**And** SHALL display the main application interface

#### Scenario: User login

**Given** a registered user provides valid credentials
**When** the user submits the login form
**Then** the system SHALL authenticate the user
**And** SHALL retrieve the user's session
**And** SHALL display the user's email in the application header

#### Scenario: User logout

**Given** an authenticated user
**When** the user clicks the sign out button
**Then** the system SHALL clear the user session
**And** SHALL return to the login screen

#### Scenario: Session persistence

**Given** an authenticated user
**When** the user refreshes the page
**Then** the system SHALL restore the user session
**And** SHALL maintain authentication state

---

### Requirement: Rayfin Client Service Initialization

The notes-app SHALL provide a singleton RayfinClient service that initializes and manages the Rayfin client instance for use by all Rayfin-backed services.

**ID**: `REQ-NOTES-RAYFIN-001`

**Priority**: High

**Rationale**: Centralized client management ensures consistent configuration and prevents multiple client instances with potentially conflicting settings.

#### Scenario: Initialize RayfinClient on first access

**Given** the application is running in Rayfin mode
**When** a service requests the RayfinClient for the first time
**Then** the RayfinClientService SHALL initialize a new RayfinClient instance with the configured base URL and publishable key
**And** SHALL cache the instance for subsequent requests
**And** SHALL expose a `getRayfinClient()` helper function returning the typed client

#### Scenario: Handle client initialization failure

**Given** the RayfinClientService attempts to initialize the client
**When** required environment variables are missing or invalid
**Then** the service SHALL throw a descriptive error
**And** the error message SHALL indicate which configuration is missing
**And** the ServiceContainer SHALL catch this error and fall back to mock mode

---

### Requirement: Note Management

The notes-app SHALL provide full CRUD operations for notes with support for both mock and Rayfin backends.

**ID**: `REQ-NOTES-NOTE-001`

**Priority**: High

**Rationale**: Note management is the core functionality demonstrating data operations via Rayfin's GraphQL API.

#### Scenario: Retrieve user's notes

**Given** a user is authenticated
**When** the application loads the user's notes
**Then** the system SHALL fetch all notes belonging to the user
**And** SHALL order notes by creation date descending
**And** SHALL display notes in the note list

#### Scenario: Create new note

**Given** a user is authenticated and has selected a notebook
**When** the user creates a new note with title and content
**Then** the system SHALL save the note to the selected notebook
**And** the create input SHALL support relationship assignment with either `notebook: { id: '<notebook-id>' }` or a full notebook object
**And** SHALL include auto-generated timestamps
**And** SHALL associate the note with the current user
**And** SHALL display the new note in the note list

#### Scenario: Update existing note

**Given** a user has selected a note
**When** the user edits the note's title or content
**Then** the system SHALL save the changes
**And** the update input SHALL support reassigning notebook via `notebook: { id: '<notebook-id>' }`
**And** SHALL update the modified timestamp
**And** SHALL reflect changes in the note list

#### Scenario: Delete note

**Given** a user has selected a note
**When** the user confirms deletion
**Then** the system SHALL remove the note
**And** SHALL remove it from the note list
**And** SHALL clear the editor if the deleted note was selected

#### Scenario: Pin/unpin note

**Given** a user has a note
**When** the user toggles the pin status
**Then** the system SHALL update the note's pinned state
**And** SHALL display a pin indicator for pinned notes

---

### Requirement: Notebook Management

The notes-app SHALL provide notebook organization with CRUD operations and default notebook semantics.

**ID**: `REQ-NOTES-NOTEBOOK-001`

**Priority**: High

**Rationale**: Notebooks provide organizational structure for notes and demonstrate hierarchical data relationships in Rayfin.

#### Scenario: Retrieve user's notebooks

**Given** a user is authenticated
**When** the application loads the user's notebooks
**Then** the system SHALL fetch all notebooks belonging to the user
**And** SHALL identify the default notebook
**And** SHALL display notebooks in the notebook navigation

#### Scenario: Create notebook

**Given** a user is authenticated
**When** the user creates a notebook with a name
**Then** the system SHALL create the notebook for the user
**And** IF no default notebook exists, SHALL set the new notebook as default
**And** SHALL select the new notebook
**And** SHALL display it in the notebook list

#### Scenario: Rename notebook

**Given** a user has selected a notebook
**When** the user provides a new name
**Then** the system SHALL update the notebook name
**And** SHALL reflect the change in the notebook list

#### Scenario: Delete notebook

**Given** a user has selected a notebook
**When** the user confirms deletion
**Then** the system SHALL delete the notebook and all its notes
**And** IF the notebook was default, SHALL promote another notebook to default
**And** SHALL remove it from the notebook list

#### Scenario: Set default notebook

**Given** a user has multiple notebooks
**When** the user sets a notebook as default
**Then** the system SHALL mark that notebook as default
**And** SHALL unmark any previous default notebook
**And** SHALL display a default indicator on the notebook

---

### Requirement: Notebook Navigation and Filtering

The notes-app UI SHALL display a list of notebooks with an "All notebooks" option and MUST scope the note list to the selected notebook.

**ID**: `REQ-NOTES-UI-001`

**Priority**: High

**Rationale**: Notebook filtering provides essential navigation and demonstrates UI patterns for filtered data views.

#### Scenario: Selecting a notebook filters notes

**Given** a user has notes in multiple notebooks
**When** the user selects a notebook from the notebook list
**Then** the note list SHALL display only notes belonging to that notebook
**And** SHALL maintain the selection state

#### Scenario: Viewing all notebooks

**Given** a user has notes in multiple notebooks
**When** the user selects "All notebooks"
**Then** the note list SHALL display notes from all notebooks
**And** SHALL group notes by notebook name

#### Scenario: Note creation respects selected notebook

**Given** a user has selected a specific notebook
**When** the user creates a new note
**Then** the note SHALL be associated with the selected notebook by default

#### Scenario: Service layer uses relationship shorthand for notebook assignment

**Given** the application writes notes through Rayfin data services
**When** creating or updating a note notebook relationship
**Then** the service SHOULD prefer `notebook: { id: '<notebook-id>' }` for relationship mutation input
**And** the service MAY use full notebook objects when those objects are already loaded and validated

---

### Requirement: Empty State Handling

The UI SHALL present appropriate empty states for notebooks and notes.

**ID**: `REQ-NOTES-UI-002`

**Priority**: Medium

**Rationale**: Empty states guide users through initial setup and improve user experience.

#### Scenario: No notebooks exist

**Given** a user has zero notebooks
**When** the user views the application
**Then** the UI SHALL display a prompt to create a notebook
**And** SHALL prevent note creation until a notebook exists

#### Scenario: Selected notebook has no notes

**Given** a user has selected an empty notebook
**When** the user views the note list
**Then** the UI SHALL display an empty state message
**And** SHALL provide a create note call-to-action

---

### Requirement: Environment Configuration

The notes-app SHALL require environment variables for Rayfin backend operation.

**ID**: `REQ-NOTES-CONFIG-001`

**Priority**: High

**Rationale**: Configuration must be externalized to support different deployment environments.

#### Scenario: Required environment variables

**Given** the application is starting
**When** the configuration is loaded
**Then** the system SHALL use the shared script `samples/scripts/generate-env-local.js` to read the port from `rayfin/.temp/.env` and generate `VITE_RAYFIN_API_URL` and `VITE_RAYFIN_PUBLISHABLE_KEY`
**And** SHALL use these values to initialize the RayfinClient

#### Scenario: Missing required configuration

**Given** the application is starting
**When** required environment variables are missing
**Then** the system SHALL throw a descriptive error
**And** SHALL indicate which variables are missing

---

### Requirement: Error Handling and Resilience

The notes-app SHALL gracefully handle service failures and provide user-friendly error messages.

**ID**: `REQ-NOTES-ERROR-001`

**Priority**: Medium

**Rationale**: Network issues or backend downtime should present clear error messages to users.

#### Scenario: Authentication failure

**Given** a user attempts to authenticate
**When** the authentication request fails
**Then** the system SHALL display a user-friendly error message
**And** SHALL not expose internal error details
**And** SHALL allow the user to retry

#### Scenario: Data operation failure

**Given** a user performs a data operation (create, update, delete)
**When** the operation fails due to network or backend error
**Then** the system SHALL display an error message
**And** SHALL log the error details
**And** SHALL maintain the application state

#### Scenario: Backend unavailable at startup

**Given** the application is starting
**When** the Rayfin backend is not reachable
**Then** the system SHALL display a clear error message indicating the backend is unavailable
**And** SHALL provide guidance on starting the backend

## Technical Architecture

### Service Layer

The notes-app implements a service layer with the following interfaces:

- **IAuthService**: Authentication operations (login, logout, register, getCurrentUser)
- **INoteService**: Note CRUD operations and pin management
- **INotebookService**: Notebook CRUD operations and default notebook management
- **ITagService**: Tag operations (future feature)
- **IStorageService**: Storage abstraction for profile images and attachments

Each interface has two implementations:

- **Mock implementation**: Uses localStorage for persistence, suitable for development without backend
- **Rayfin implementation**: Uses RayfinClient to communicate with backend API

### Data Models

- **AuthUser**: User authentication model with Id and Email
- **Note**: Note entity with title, content, notebook association, timestamps, and pin status
- **Notebook**: Notebook entity with name, user association, and default flag
- **Tag**: Tag entity for categorization (future feature)

### React Hooks

- **useAuth**: Manages authentication state and operations
- **useNotes**: Manages note list state and CRUD operations
- **useNotebooks**: Manages notebook list state and CRUD operations

### Component Structure

- **App**: Main application component orchestrating all features
- **LoginForm**: Authentication UI with login and registration
- **NotebookNav**: Notebook list and navigation sidebar
- **NoteList**: Filterable list of notes with grouping support
- **NoteEditor**: Rich text editor for creating and editing notes
- **NoteViewer**: Read-only note display
- **ServiceModeBanner**: Development mode indicator showing active backend

---

## Related Documentation

- Builder guide: `samples/notes-app/README.md`
- Contributor guide: `samples/notes-app/AGENTS.md`
- Rayfin client API: `packages/typescript-sdk/client/README.md`
- Service architecture patterns: `docs/contributor/patterns/service-container.md` (future)
