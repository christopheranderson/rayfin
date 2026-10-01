# builder-documentation Specification

## Purpose

To help builders understand how to use Project Rayfin as a backend for their frontend.

## Requirements

### Requirement: Quick Start Workflow

Builder documentation SHALL provide a complete, verified workflow from zero to running application using template scaffolding.

**ID**: `BUILDER-DOC-001`

**Priority**: High

**Rationale**: New Builders need immediate success to validate the platform. Starting from a working template reduces friction and provides a reference implementation. This change updates the quick start to emphasize the template-first approach.

**Changes from Previous**:
- Scaffolding step now uses `npm create @microsoft/rayfin@latest` as the primary entry point
- Order updated to: prerequisites → scaffold → start services (implicit apply schema) → run frontend
- Removed references to `rayfin init` as a first step (now a post-scaffold context)

#### Scenario: Builder scaffolds and runs a Rayfin template

**Given** a Builder has prerequisites installed (Node.js, Docker, GitHub auth)
**When** they follow the Quick Start guide in `packages/guide/assets/docs/getting-started/index.md`
**Then** they SHALL scaffold a project using `npm create @microsoft/rayfin@latest`
**And** they SHALL select any template from the CLI prompt (todo-app, welcome-app-react, welcome-app-react-ui-components, or welcome-app-typescript)
**And** they SHALL start services with `npx rayfin dev`
**And** they SHALL start the frontend with `npm run dev`
**And** they SHALL see a running application within 15 minutes
**And** each step SHALL have observable success criteria

**Acceptance Criteria:**

- Prerequisites section lists Node.js, Docker Desktop, GitHub CLI with version requirements
- Scaffolding is the first action step using `npm create @microsoft/rayfin@latest`
- Service startup uses `npx rayfin dev` (not `rayfin dev` without npx)
- Database application uses `npx rayfin dev db apply` (not separate `rayfin db` command)
- Storage configuration (if needed) uses `npx rayfin dev storage apply`
- Frontend startup uses `npm run dev` from scaffolded project
- Each step states expected output or success indicator
- Total time estimate is 15 minutes for complete workflow

---

### Requirement: Platform-Specific Instructions

Builder documentation SHALL provide installation and setup instructions for Windows, macOS, and Linux.

**ID**: `BUILDER-DOC-002`

**Priority**: High

**Rationale**: Builders use diverse operating systems. Platform-specific guidance reduces setup failures and support requests.

#### Scenario: Builder installs prerequisites on macOS

**Given** a Builder is using macOS
**When** they follow the Prerequisites section
**Then** they SHALL see Homebrew-based installation commands for Node.js, Docker Desktop, and GitHub CLI
**And** commands SHALL be current and functional for macOS

#### Scenario: Builder installs prerequisites on Windows

**Given** a Builder is using Windows
**When** they follow the Prerequisites section
**Then** they SHALL see winget or manual installation instructions for Node.js, Docker Desktop, and GitHub CLI
**And** commands SHALL be current and functional for Windows

#### Scenario: Builder installs prerequisites on Linux

**Given** a Builder is using Ubuntu/Debian-based Linux
**When** they follow the Prerequisites section
**Then** they SHALL see apt-based installation commands for Node.js, Docker Desktop, and GitHub CLI
**And** commands SHALL be current and functional for Linux

**Acceptance Criteria:**

- Prerequisites section uses platform-specific subsections or clear delineation
- Installation commands are tested and current for each platform
- Platform differences are explicitly called out (for example, Docker Desktop vs Docker Engine on Linux)
- Links to official installation guides are provided for complex installs

---

### Requirement: Troubleshooting Guide

Builder documentation SHALL include troubleshooting for common setup and runtime issues.

**ID**: `BUILDER-DOC-003`

**Priority**: Medium

**Rationale**: First-time setup frequently encounters predictable issues. Providing solutions upfront reduces frustration and support burden.

#### Scenario: Builder encounters Docker not running error

**Given** a Builder has Docker Desktop installed but not running
**When** they execute `npx rayfin dev`
**Then** they SHALL see an error about Docker not being available
**And** the Troubleshooting section SHALL provide steps to start Docker Desktop
**And** SHALL explain how to verify Docker is running

#### Scenario: Builder encounters GitHub authentication failure

**Given** a Builder has not authenticated with GitHub Packages
**When** they run `npm create @microsoft/rayfin@latest`
**Then** they SHALL see a 401 or 403 error
**And** the Troubleshooting section SHALL direct them to the authentication setup
**And** SHALL provide the command to verify authentication status

#### Scenario: Builder encounters port conflict

**Given** a Builder has another service running on port 5168
**When** they execute `npx rayfin dev`
**Then** they SHALL see a port binding error
**And** the Troubleshooting section SHALL explain how to identify the conflicting process
**And** SHALL provide options to stop the conflict or configure alternate ports

**Acceptance Criteria:**

- Troubleshooting section appears after Quick Start
- Each issue includes: symptom, cause, solution
- Solutions are specific and actionable
- Common issues covered: Docker not running, auth failures, port conflicts, database connection errors
- Cross-references to relevant documentation sections

---

### Requirement: Prerequisites Documentation

Builder documentation SHALL list all prerequisite tools with version requirements and installation commands.

**ID**: `BUILDER-DOC-004`

**Priority**: High

**Rationale**: Builders need to know what tools to install before starting. Clear prerequisites prevent mid-workflow failures.

#### Scenario: Builder checks prerequisites before starting

**Given** a Builder is reviewing the Quick Start guide
**When** they read the Prerequisites section  **Then** they SHALL see a list of required tools: Node.js, Docker Desktop, GitHub CLI
**And** each tool SHALL state minimum version requirement
**And** each tool SHALL provide installation commands for Windows, macOS, and Linux
**And** each tool SHALL link to official installation documentation

**Acceptance Criteria:**

- Prerequisites section exists before Quick Start
- Node.js version requirement stated (>= 20.0.0)
- Docker Desktop installation covered for all platforms
- GitHub CLI installation covered for all platforms
- Version check commands provided (for example, `node --version`, `docker --version`, `gh --version`)
- Links to official installation guides included

---

### Requirement: Authentication Setup Documentation

Builder documentation SHALL guide users through GitHub Packages authentication using existing repository scripts.

**ID**: `BUILDER-DOC-005`

**Priority**: High

**Rationale**: Private packages require authentication. Builders need clear guidance to use the existing auth scripts.

#### Scenario: Builder authenticates on macOS or Linux using bash script

**Given** a Builder is on macOS or Linux
**And** has GitHub CLI installed and authenticated
**When** they follow the authentication setup instructions
**Then** they SHALL download `setup-npm-auth.sh` from the repository
**And** SHALL execute the script with appropriate flags
**And** SHALL verify authentication succeeds

#### Scenario: Builder authenticates on Windows using PowerShell script

**Given** a Builder is on Windows
**And** has GitHub CLI installed and authenticated
**When** they follow the authentication setup instructions
**Then** they SHALL download `setup-npm-auth.ps1` from the repository
**And** SHALL execute the script with appropriate parameters
**And** SHALL verify authentication succeeds

**Acceptance Criteria:**

- Quick Start references authentication as Step 1
- Links to `common/scripts/npm-auth/README.md` for detailed instructions
- Provides quick commands for bash and PowerShell scripts
- Explains what the scripts do at a high level
- Notes that `gh auth login` is a prerequisite
- Provides verification command to test authentication

---

### Requirement: Template Scaffolding Documentation

Builder documentation SHALL demonstrate how to create a new project from available templates.

**ID**: `BUILDER-DOC-006`

**Priority**: High

**Rationale**: `create-rayfin` is the primary entry point for new projects. Documentation must clearly show its usage.

#### Scenario: Builder scaffolds a new project

**Given** a Builder has completed prerequisites and authentication
**When** they follow Step 2 of the Quick Start
**Then** they SHALL execute `npm create @microsoft/rayfin@latest`
**And** SHALL be prompted to select a template
**And** SHALL provide a project name
**And** SHALL see the template scaffold successfully

**Acceptance Criteria:**

- Quick Start shows `npm create @microsoft/rayfin@latest` command
- Mentions available templates
- Notes the interactive prompts for template and project name
- States expected output: "Project created successfully" or similar
- Links to sample READMEs for template details

---

### Requirement: Service Startup Documentation

Builder documentation SHALL provide the command sequence to start Rayfin services and apply database schema.

**ID**: `BUILDER-DOC-007`

**Priority**: High

**Rationale**: After scaffolding, Builders need to start backend services and initialize the database to have a functional application.

#### Scenario: Builder starts Rayfin services

**Given** a Builder has scaffolded a new project
**And** has navigated into the project directory
**When** they execute `npx rayfin dev`
**Then** Rayfin services SHALL start in Docker containers
**And** the CLI SHALL output service URLs and health status
**And** services SHALL be accessible at documented ports

#### Scenario: Builder applies database schema

**Given** a Builder has Rayfin services running
**When** they execute `npx rayfin dev db apply`
**Then** the CLI SHALL generate and apply database migrations
**And** SHALL output confirmation of schema application
**And** database SHALL be ready for data operations

**Acceptance Criteria:**

- Quick Start includes `npx rayfin dev` as Step 4
- Explains what services are started (webservice, sqlserver, etc.)
- Notes expected startup time and health check indicators
- Quick Start includes `npx rayfin dev db apply` as Step 5
- Explains that this initializes the database schema
- States expected success message
- Notes that this step is required before frontend can interact with data

---

### Requirement: Frontend Startup Documentation

Builder documentation SHALL show how to start the frontend development server after services are running.

**ID**: `BUILDER-DOC-008`

**Priority**: Medium

**Rationale**: The final step is running the frontend. Clear documentation completes the end-to-end workflow.

#### Scenario: Builder starts frontend development server

**Given** a Builder has Rayfin services running
**And** has applied the database schema
**When** they execute `npm run dev`
**Then** the frontend development server SHALL start
**And** SHALL output the local URL (typically `http://localhost:5173`)
**And** the application SHALL be accessible in a browser

**Acceptance Criteria:**

- Quick Start includes `npm run dev` as Step 6
- Explains this starts the frontend development server
- States typical local URL (`http://localhost:5173`)
- Notes to open the URL in a browser
- Mentions that the application is now fully functional
- Links to sample-specific README for app-specific features

### Requirement: AI Agent Instructions for Builders

Builder documentation SHALL include tool-agnostic instructions for AI coding assistants to guide Builders through template-based development workflows.

**ID**: `BUILDER-DOC-009`

**Priority**: High

**Rationale**: Many Builders use AI assistants (GitHub Copilot, Claude, ChatGPT, Cursor, etc.) for development. Providing agent-specific instructions enables these tools to give accurate, workflow-appropriate guidance. A template-first approach matches the recommended Builder workflow and reduces the learning curve. Template-agnostic patterns ensure instructions work across all available templates.

#### Scenario: AI assistant guides Builder through template scaffolding

**Given** a Builder asks an AI assistant "How do I start a new Rayfin project?"
**When** the AI assistant consults the agent instructions
**Then** it SHALL recommend scaffolding from a template using `npm create @microsoft/rayfin@latest`
**And** it SHALL NOT recommend building from scratch with `rayfin init` as the first step
**And** it SHALL explain the available template options without favoring one over another

#### Scenario: AI assistant helps Builder add a new entity

**Given** a Builder has scaffolded a project from any Rayfin template
**And** asks "How do I add a new entity to my app?"
**When** the AI assistant consults the agent instructions
**Then** it SHALL guide the Builder to create a new entity file in `rayfin/data/`
**And** it SHALL provide a generic example showing entity decorator patterns
**And** it SHALL remind the Builder to update the schema type in `rayfin/data/schema.ts`
**And** it SHALL recommend running `npx rayfin dev db apply` to apply the schema changes

#### Scenario: AI assistant provides accurate CLI commands

**Given** a Builder asks "How do I start the local development environment?"
**When** the AI assistant consults the agent instructions
**Then** it SHALL provide the current command `npx rayfin dev`
**And** it SHALL NOT provide deprecated commands
**And** it SHALL explain what the command does (starts SQL Server, auth service, etc.)

#### Scenario: AI assistant references template-agnostic patterns

**Given** a Builder asks "How do I use the Rayfin client for GraphQL queries?"
**When** the AI assistant consults the agent instructions
**Then** it SHALL provide template-agnostic code examples showing `client.data.gql` patterns
**And** examples SHALL show core operations like `select(...).execute()`, `create()`, `update()`, `delete()`
**And** create and update examples SHALL include relationship shorthand patterns like `{ category: { id: '...' } }`
**And** it SHALL reference the schema type pattern from `rayfin/data/schema.ts`
**And** examples SHALL work across todo-app, welcome-app-react, welcome-app-react-ui-components, and welcome-app-typescript templates

**Acceptance Criteria:**

- Agent instructions exist in `packages/tools/cli/assets/AGENTS.md` (tool-agnostic filename)
- Instructions are structured as template-first workflow (scaffold, understand, extend)
- All CLI commands match current implementation (`rayfin dev`, `rayfin dev db apply`, etc.)
- Code examples are template-agnostic and work across all templates
- Relationship mutation examples include both ID-only shorthand and full object options where relevant
- Instructions cover: data entities, authentication, storage, and service patterns
- File does not contain GitHub Copilot-specific branding or tool-specific language
- Instructions link to all template READMEs and CLI documentation

---
