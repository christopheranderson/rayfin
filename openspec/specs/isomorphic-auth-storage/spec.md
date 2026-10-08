# isomorphic-auth-storage Specification

## Purpose

Define the isomorphic storage model for the TypeScript Auth SDK — an async-capable `AuthStorage` interface, browser-guarded construction, storage-routed PKCE state, constructor opt-outs, and lazy initialization — so the SDK works unchanged across browser, Node.js, and SSR environments.

## Requirements

### Requirement: Async-capable AuthStorage interface

The `AuthStorage` interface in `@microsoft/rayfin-auth` SHALL accept both synchronous and asynchronous storage implementations via union return types.

#### Scenario: AuthStorage getItem returns sync or async

- **WHEN** a consumer implements `AuthStorage.getItem(key)`
- **THEN** the return type MUST be `string | null | Promise<string | null>`
- **AND** the `Auth` class MUST `await` the result at every call site

#### Scenario: AuthStorage setItem returns sync or async

- **WHEN** a consumer implements `AuthStorage.setItem(key, value)`
- **THEN** the return type MUST be `void | Promise<void>`
- **AND** the `Auth` class MUST `await` the result at every call site

#### Scenario: AuthStorage removeItem returns sync or async

- **WHEN** a consumer implements `AuthStorage.removeItem(key)`
- **THEN** the return type MUST be `void | Promise<void>`
- **AND** the `Auth` class MUST `await` the result at every call site

#### Scenario: AuthStorage clear is optional

- **WHEN** a consumer implements `AuthStorage`
- **THEN** `clear()` MUST be an optional method with return type `void | Promise<void>`
- **AND** the `Auth` class MUST call `this.storage.clear?.()` defensively

#### Scenario: AuthStorage keys is optional

- **WHEN** a consumer implements `AuthStorage`
- **THEN** `keys(prefix: string)` MUST be an optional method with return type `string[] | Promise<string[]>`
- **AND** the `Auth` class MUST skip PKCE cleanup when `keys` is not implemented

#### Scenario: Existing localStorage consumers are not broken

- **WHEN** a consumer passes `window.localStorage` as storage (or relies on the default)
- **THEN** all synchronous return values MUST satisfy the widened union types without any code changes
- **AND** existing behavior MUST be identical to before the interface change

### Requirement: Browser-guarded Auth constructor

The `Auth` class constructor SHALL NOT crash when instantiated outside a browser environment.

#### Scenario: Auth constructed in Node.js without options

- **WHEN** `new Auth(apiClient)` is called in a Node.js environment where `window` is undefined
- **THEN** the constructor MUST NOT throw a `ReferenceError`
- **AND** `this.storage` MUST default to `null` (memory-only mode)
- **AND** multi-tab sync MUST NOT be registered

#### Scenario: Auth constructed in Node.js with storage false

- **WHEN** `new Auth(apiClient, { storage: false })` is called in Node.js
- **THEN** the constructor MUST NOT throw
- **AND** `this.storage` MUST be `null`

#### Scenario: Auth constructed in Node.js with custom storage

- **WHEN** `new Auth(apiClient, { storage: myAsyncStorage })` is called in Node.js
- **THEN** the constructor MUST NOT throw
- **AND** `this.storage` MUST be set to the provided implementation
- **AND** session restoration MUST occur via lazy initialization on first public method call

#### Scenario: Auth constructed in browser preserves current behavior

- **WHEN** `new Auth(apiClient)` is called in a browser environment
- **THEN** `this.storage` MUST default to `window.localStorage`
- **AND** `window.addEventListener('storage', ...)` MUST be registered for multi-tab sync
- **AND** behavior MUST be identical to before the change

### Requirement: PKCE state routed through configured storage

The `Auth` class SHALL route all PKCE state operations through `this.storage` instead of hardcoded `window.localStorage`.

#### Scenario: sendMagicLink stores PKCE state via this.storage

- **WHEN** `auth.sendMagicLink()` is called
- **AND** `this.storage` is not `null`
- **THEN** the PKCE state (code verifier, redirect URI, timestamp) MUST be stored via `await this.storage.setItem()`
- **AND** the storage key MUST be `{PKCE_STATE_PREFIX}{state}`
- **AND** `window.localStorage` MUST NOT be accessed directly

#### Scenario: sendMagicLink uses in-memory fallback when storage is null

- **WHEN** `auth.sendMagicLink()` is called
- **AND** `this.storage` is `null`
- **THEN** the PKCE state MUST be held in an in-memory `Map` on the `Auth` instance
- **AND** the flow MUST work within a single page session

#### Scenario: handleMagicLinkCallback reads PKCE state via this.storage

- **WHEN** `auth.handleMagicLinkCallback()` is called
- **AND** `this.storage` is not `null`
- **THEN** the PKCE state MUST be retrieved via `await this.storage.getItem()`
- **AND** the PKCE state MUST be removed via `await this.storage.removeItem()` after use
- **AND** `window.localStorage` MUST NOT be accessed directly

#### Scenario: handleMagicLinkCallback reads from in-memory fallback

- **WHEN** `auth.handleMagicLinkCallback()` is called
- **AND** `this.storage` is `null`
- **THEN** the PKCE state MUST be retrieved from the in-memory `Map`
- **AND** the entry MUST be deleted from the `Map` after use

#### Scenario: cleanupStalePkceStates uses storage keys method

- **WHEN** `Auth` initializes and calls `cleanupStalePkceStates()`
- **AND** `this.storage` implements the optional `keys(prefix)` method
- **THEN** stale PKCE states MUST be enumerated via `await this.storage.keys(this.PKCE_STATE_PREFIX)`
- **AND** expired entries MUST be removed via `await this.storage.removeItem(key)`
- **AND** `window.localStorage` MUST NOT be accessed directly

#### Scenario: cleanupStalePkceStates skips when keys is not available

- **WHEN** `Auth` initializes and calls `cleanupStalePkceStates()`
- **AND** `this.storage` does not implement `keys()`
- **THEN** cleanup MUST be silently skipped
- **AND** no error MUST be thrown

### Requirement: Auth constructor opt-out configuration

The `Auth` constructor SHALL accept opt-out flags for persistence, auto-refresh, and multi-tab sync.

#### Scenario: persistSession false disables all storage I/O

- **WHEN** `new Auth(apiClient, { persistSession: false })` is called
- **THEN** all `this.storage` reads and writes MUST be skipped
- **AND** the session MUST be held in memory only
- **AND** PKCE state MUST use the in-memory fallback
- **AND** the default value MUST be `true`

#### Scenario: autoRefreshToken false disables expiration timers

- **WHEN** `new Auth(apiClient, { autoRefreshToken: false })` is called
- **THEN** session expiration timers MUST NOT be scheduled
- **AND** automatic refresh on 401 MUST be disabled
- **AND** the default value MUST be `true`

#### Scenario: multiTabSync false skips StorageEvent listener

- **WHEN** `new Auth(apiClient, { multiTabSync: false })` is called
- **THEN** `window.addEventListener('storage', ...)` MUST NOT be called
- **AND** session changes from other tabs MUST NOT be synchronized
- **AND** the default value MUST be auto-detected (true in browser with localStorage, false otherwise)

#### Scenario: All defaults match current behavior

- **WHEN** `new Auth(apiClient)` is called in a browser with no options
- **THEN** `persistSession` MUST default to `true`
- **AND** `autoRefreshToken` MUST default to `true`
- **AND** `multiTabSync` MUST default to `true` (because localStorage is the default storage)
- **AND** behavior MUST be identical to before the change

### Requirement: Lazy initialization for async storage

The `Auth` class SHALL defer storage reads from the constructor to a lazy initialization method to support async storage backends.

#### Scenario: First public method call triggers initialization

- **WHEN** `Auth` is constructed with an async storage backend
- **AND** the consumer calls any public method (e.g., `getSession()`, `signIn()`)
- **THEN** the `Auth` class MUST `await` the initialization (session restoration, PKCE cleanup) before proceeding
- **AND** initialization MUST run exactly once

#### Scenario: Subsequent calls skip initialization

- **WHEN** initialization has already completed
- **AND** the consumer calls another public method
- **THEN** the initialization MUST NOT run again
- **AND** the call MUST proceed immediately

#### Scenario: Sync storage initialization is transparent

- **WHEN** `Auth` is constructed with `localStorage` (sync storage)
- **THEN** the lazy init `await` MUST resolve synchronously
- **AND** there MUST be no observable behavior change compared to the current synchronous constructor
