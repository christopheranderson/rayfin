# e2e-testing-infrastructure Specification

## Purpose

Add e2e tests using the todo-app that can be used to prevent regressions.

## Requirements

### Requirement: E2E Test Folder Structure

The system SHALL organize E2E tests into a hierarchical folder structure separating API and UI tests with shared utilities.

#### Scenario: API tests organized by domain

- **GIVEN** the e2e test folder structure
- **WHEN** a developer navigates to `e2e/api/`
- **THEN** they find subfolders for `auth/`, `data/`, and `control/` organizing tests by domain

#### Scenario: UI tests organized by feature

- **GIVEN** the e2e test folder structure
- **WHEN** a developer navigates to `e2e/ui/`
- **THEN** they find subfolders for `auth/`, `todos/`, and `profile/` organizing tests by feature

#### Scenario: Shared utilities accessible to both test types

- **GIVEN** the e2e test folder structure
- **WHEN** a developer imports from `e2e/shared/`
- **THEN** both API and UI tests can use the same backend and test data utilities

### Requirement: Shared Backend Lifecycle

The system SHALL manage a single Rayfin backend instance shared across all parallel test workers.

#### Scenario: Backend starts once in global setup

- **GIVEN** Playwright tests are executed
- **WHEN** global setup runs before all tests
- **THEN** the backend starts once and waits for health check to pass

#### Scenario: Backend accessible to all workers

- **GIVEN** the backend is running on port 5168
- **WHEN** multiple Playwright workers execute tests in parallel
- **THEN** all workers can connect to the same backend instance

#### Scenario: Backend stops in global teardown

- **GIVEN** all tests have completed
- **WHEN** global teardown runs
- **THEN** the backend containers are stopped and purged

#### Scenario: Backend kept running for debugging

- **GIVEN** the environment variable `E2E_KEEP_BACKEND_RUNNING=true`
- **WHEN** global teardown runs
- **THEN** the backend remains running for manual inspection

### Requirement: Per-Worker Frontend Servers

The system SHALL spawn isolated Vite dev servers for each Playwright worker using a centralized port pool manager.

#### Scenario: Port allocated from pool

- **GIVEN** the port pool manager with ports 5173-5182 available
- **WHEN** the frontend fixture initializes for a worker
- **THEN** the pool allocates the next available port and marks it as in-use

#### Scenario: Maximum workers enforced

- **GIVEN** all 10 ports in the pool are allocated
- **WHEN** another worker requests a port
- **THEN** an error is thrown indicating the maximum concurrent workers limit is reached

#### Scenario: Port returned to pool on cleanup

- **GIVEN** a worker with an allocated frontend server
- **WHEN** the frontend fixture teardown runs
- **THEN** the port is released back to the pool for reuse

#### Scenario: Frontend starts before tests in file

- **GIVEN** a test file using the `frontendUrl` fixture
- **WHEN** the test file begins execution
- **THEN** the Vite server is started and healthy before any test runs

#### Scenario: Frontend stops after tests in file

- **GIVEN** a test file has completed all tests
- **WHEN** the test file teardown runs
- **THEN** the Vite server process is terminated and port is released

#### Scenario: Frontend connects to shared backend

- **GIVEN** a Vite server starting for a worker
- **WHEN** the frontend environment is configured
- **THEN** `VITE_RAYFIN_API_URL` is set to `http://localhost:5168`

### Requirement: Test Data Isolation

The system SHALL generate unique test data per test to enable parallel execution without conflicts.

#### Scenario: Unique user per test

- **GIVEN** a test using the `testUser` fixture
- **WHEN** the fixture generates user credentials
- **THEN** the email includes a timestamp and random suffix (e.g., `test-1702900000000-abc123@example.com`)

#### Scenario: Unique todo per test

- **GIVEN** a test creating a todo item
- **WHEN** the test data generator is called
- **THEN** the todo title includes a timestamp and random suffix for uniqueness

#### Scenario: No cleanup required between tests

- **GIVEN** each test uses unique data
- **WHEN** tests run in parallel
- **THEN** no test interferes with another test's data

### Requirement: Playwright Configuration

The system SHALL provide Playwright configuration optimized for Rayfin app testing.

#### Scenario: Parallel execution enabled

- **GIVEN** the Playwright configuration
- **WHEN** tests are executed
- **THEN** `fullyParallel: true` enables maximum parallelization

#### Scenario: Retries in CI

- **GIVEN** tests running in CI environment (`CI=true`)
- **WHEN** a test fails
- **THEN** it is retried up to 2 times before marking as failed

#### Scenario: Traces captured on retry

- **GIVEN** a test that fails on first attempt
- **WHEN** the test is retried
- **THEN** a trace file is captured for debugging

#### Scenario: Screenshots on failure

- **GIVEN** a test that fails
- **WHEN** the failure is recorded
- **THEN** a screenshot is captured for debugging

### Requirement: npm Scripts

The system SHALL provide npm scripts for running E2E tests locally and in CI.

#### Scenario: Run all E2E tests

- **WHEN** developer runs `rushx test:e2e`
- **THEN** both API and UI E2E tests execute sequentially

#### Scenario: Run API tests only

- **WHEN** developer runs `rushx test:e2e:api`
- **THEN** only Vitest API tests execute

#### Scenario: Run UI tests only

- **WHEN** developer runs `rushx test:e2e:ui`
- **THEN** only Playwright UI tests execute

#### Scenario: Run UI tests in headed mode

- **WHEN** developer runs `rushx test:e2e:ui:headed`
- **THEN** Playwright launches visible browser windows

#### Scenario: Debug UI tests

- **WHEN** developer runs `rushx test:e2e:ui:debug`
- **THEN** Playwright opens in debug mode with `E2E_KEEP_BACKEND_RUNNING=true`

### Requirement: CI Pipeline Integration

The system SHALL provide GitHub Actions workflow for automated E2E testing.

#### Scenario: Workflow triggers on relevant changes

- **GIVEN** a pull request modifying `samples/todo-app/**`, `packages/typescript-sdk/**`, or `packages/host/**`
- **WHEN** the PR is opened or updated
- **THEN** the E2E test workflow is triggered

#### Scenario: Playwright browsers installed in CI

- **GIVEN** the CI workflow runs
- **WHEN** the Playwright setup step executes
- **THEN** Chromium is installed with system dependencies

#### Scenario: Test artifacts uploaded on failure

- **GIVEN** E2E tests fail in CI
- **WHEN** the workflow completes
- **THEN** Playwright report and traces are uploaded as artifacts

#### Scenario: Tests run with limited workers in CI

- **GIVEN** tests running in CI environment
- **WHEN** Playwright configuration is applied
- **THEN** worker count is limited to 4 for resource management
