# auth-refresh-lifecycle Specification

## Purpose

Define the manual token-refresh lifecycle of the TypeScript Auth SDK — the `startAutoRefresh()`/`stopAutoRefresh()` methods and their interaction with session expiration scheduling — so consumers that opt out of automatic refresh can drive it explicitly (e.g. React Native `AppState`).

## Requirements

### Requirement: Manual refresh lifecycle methods

The `Auth` class SHALL provide public `startAutoRefresh()` and `stopAutoRefresh()` methods for manual control of the token refresh cycle.

#### Scenario: stopAutoRefresh cancels scheduled refresh

- **WHEN** `auth.stopAutoRefresh()` is called
- **THEN** any pending session expiration timer MUST be cancelled
- **AND** no automatic token refresh MUST occur until `startAutoRefresh()` is called

#### Scenario: startAutoRefresh re-enables refresh scheduling

- **WHEN** `auth.startAutoRefresh()` is called
- **AND** a valid session exists with an expiration time
- **THEN** the session expiration timer MUST be rescheduled
- **AND** if the current access token is expired or near-expiry, a refresh MUST be triggered immediately

#### Scenario: startAutoRefresh is no-op when autoRefreshToken is true

- **WHEN** `auth.startAutoRefresh()` is called
- **AND** the `autoRefreshToken` option is `true` (default)
- **THEN** the call MUST be a no-op (auto-refresh is already running)

#### Scenario: stopAutoRefresh is no-op when autoRefreshToken is true

- **WHEN** `auth.stopAutoRefresh()` is called
- **AND** the `autoRefreshToken` option is `true` (default)
- **THEN** the call MUST be a no-op (auto-refresh lifecycle is managed automatically)

#### Scenario: React Native AppState integration

- **WHEN** a React Native consumer uses `AppState.addEventListener('change', ...)`
- **AND** calls `auth.startAutoRefresh()` when app enters foreground
- **AND** calls `auth.stopAutoRefresh()` when app enters background
- **THEN** token refresh MUST only occur while the app is in the foreground
- **AND** no timers MUST fire while the app is backgrounded
