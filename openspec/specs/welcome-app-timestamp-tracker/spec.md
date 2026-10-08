# welcome-app-timestamp-tracker Specification

## Purpose

TBD - created by archiving change add-welcome-app-timestamp-frontend. Update Purpose after archive.

## Requirements

### Requirement: Timestamp Data Model

The system SHALL provide a backend data model for tracking timestamp entries.

#### Scenario: Define timestamp entity with Rayfin decorators

- **WHEN** defining the backend model in `rayfin/data/Timestamp.ts`
- **THEN** the model includes `id` (string), `timestamp` (Date), and `createdAt` (Date) fields decorated with `@field()`
- **AND** the class is decorated with `@entity()` for DAB config generation
- **AND** anonymous permissions are set with `@role('anonymous', '*')` for quickstart ease

#### Scenario: Generate DAB configuration from model

- **WHEN** user runs `rayfin init` after defining the Timestamp model
- **THEN** the DAB configuration file includes a REST endpoint at `/api/Timestamp`
- **AND** GraphQL types for Timestamp are generated

### Requirement: Timestamp Service Interface

The system SHALL provide a TypeScript service interface for timestamp operations.

#### Scenario: Define service contract

- **WHEN** creating the `TimestampService` interface in `src/services/TimestampService.ts`
- **THEN** the interface declares `addTimestamp(): Promise<Timestamp>` method
- **AND** the interface declares `getTimestamps(): Promise<Timestamp[]>` method

#### Scenario: Implement service with Rayfin Data API client

- **WHEN** implementing `RayfinTimestampService` class
- **THEN** the implementation uses `DataApi` from `@microsoft/rayfin-data`
- **AND** `addTimestamp()` creates a new timestamp entry with the current date/time via REST POST
- **AND** `getTimestamps()` retrieves the latest 100 timestamps ordered by timestamp descending via REST GET
- **AND** proper error handling is implemented for network failures

### Requirement: Timestamp Table Display

The system SHALL display timestamps in a table format on the frontend.

#### Scenario: Render timestamp list

- **WHEN** the page loads or user clicks "Refresh"
- **THEN** the UI displays a table with columns: ID, Timestamp, Created At
- **AND** timestamps are sorted with most recent first
- **AND** up to 100 timestamps are shown

#### Scenario: Empty state display

- **WHEN** no timestamps exist in the backend
- **THEN** the table shows a message "No timestamps yet. Click 'Send Timestamp' to create one."

#### Scenario: Handle loading state

- **WHEN** data is being fetched from the backend
- **THEN** the UI displays a loading indicator
- **AND** the buttons are disabled during the fetch operation

### Requirement: Add Timestamp Button

The system SHALL provide a button to create new timestamp entries.

#### Scenario: Send current timestamp to backend

- **WHEN** user clicks the "Send Timestamp" button
- **THEN** the system calls `addTimestamp()` service method with current date/time
- **AND** the new timestamp is posted to the Rayfin backend via `/api/Timestamp` endpoint
- **AND** the table automatically refreshes to show the new entry

#### Scenario: Show success feedback

- **WHEN** timestamp is successfully created
- **THEN** the UI shows a brief success message or visual confirmation
- **AND** the table updates with the new timestamp at the top

#### Scenario: Handle creation errors

- **WHEN** the backend is unreachable or returns an error
- **THEN** the UI displays an error message to the user
- **AND** the button becomes enabled again for retry

### Requirement: Refresh Button

The system SHALL provide a button to reload timestamp data from the backend.

#### Scenario: Manual data refresh

- **WHEN** user clicks the "Refresh" button
- **THEN** the system calls `getTimestamps()` service method
- **AND** the table updates with the latest data from the backend

#### Scenario: Show stale data indicator

- **WHEN** more than 30 seconds have passed since last refresh
- **THEN** the UI shows a visual hint that data might be stale (optional enhancement)

### Requirement: Minimal UI Styling

The system SHALL provide basic styling for the timestamp tracker interface.

#### Scenario: Responsive button layout

- **WHEN** viewing the page on any screen size
- **THEN** the "Send Timestamp" and "Refresh" buttons are clearly visible and clickable
- **AND** buttons have proper spacing and hover states

#### Scenario: Table readability

- **WHEN** displaying timestamp data
- **THEN** the table has appropriate borders, padding, and typography
- **AND** timestamp values are formatted in a human-readable format (e.g., "11/14/2025 10:30:45 AM")

### Requirement: Frontend Model Type Safety

The system SHALL use TypeScript types matching the backend model.

#### Scenario: Define frontend Timestamp interface

- **WHEN** creating `src/models/Timestamp.ts`
- **THEN** the interface includes `id: string`, `timestamp: Date`, `createdAt: Date` fields
- **AND** the types align with the backend Rayfin model structure

#### Scenario: Type-safe service responses

- **WHEN** the service methods return data
- **THEN** TypeScript enforces the `Timestamp` interface type
- **AND** compiler errors prevent mismatched field access

### Requirement: Documentation for Frontend Testing

The system SHALL document how to test the timestamp tracker frontend.

#### Scenario: README quickstart completion

- **WHEN** a user follows the welcome-app README to step 6
- **THEN** the README includes instructions to open the browser at `http://localhost:5173`
- **AND** explains how to interact with the "Send Timestamp" and "Refresh" buttons
- **AND** describes what to expect when clicking each button

#### Scenario: Verify full stack integration

- **WHEN** following the documentation steps
- **THEN** users can confirm their Rayfin backend is working by seeing timestamps appear in the table
- **AND** users understand this completes the end-to-end quickstart workflow
