# sdk-api-authentication Specification

## Purpose

TBD - created by archiving change add-publishable-key-authentication. Update Purpose after archive.

## Requirements

### Requirement: SDK Publishable Key Authentication

The Rayfin SDK (TypeScript) SHALL require a publishable key for all API requests to authenticate client applications at the service level.

#### Scenario: ApiClient requires publishable key

- **WHEN** developer initializes `ApiClient` from `@microsoft/rayfin-lib`
- **THEN** the constructor MUST require a `publishableKey` parameter in the config object
- **AND** the constructor MUST throw an error if `publishableKey` is undefined, null, or empty string
- **AND** the error message MUST clearly indicate that publishable key is required

#### Scenario: RayfinClient requires publishable key

- **WHEN** developer initializes `RayfinClient` from `@microsoft/rayfin-client`
- **THEN** the constructor MUST require a `publishableKey` parameter in the config object
- **AND** the constructor MUST pass the `publishableKey` to the underlying `ApiClient`
- **AND** the constructor MUST throw an error if `publishableKey` is missing

#### Scenario: Publishable key included in all HTTP requests

- **WHEN** SDK makes any HTTP request to the Rayfin API
- **THEN** the request MUST include an `X-Publishable-Key` header
- **AND** the header value MUST be the publishable key provided during initialization
- **AND** the header MUST be included automatically without explicit developer action

#### Scenario: Invalid publishable key error handling

- **WHEN** SDK receives a 401 response with error code `INVALID_PUBLISHABLE_KEY`
- **THEN** the SDK MUST throw a descriptive error indicating the publishable key is invalid
- **AND** the error MUST be an `AuthError` type
- **AND** the error message MUST guide developers to check their configuration

#### Scenario: Missing publishable key error handling

- **WHEN** SDK receives a 401 response with error code `MISSING_PUBLISHABLE_KEY`
- **THEN** the SDK MUST throw a descriptive error indicating the header was not sent
- **AND** the error MUST suggest checking SDK initialization
- **AND** the error type MUST be `AuthError`

### Requirement: SDK Configuration Type Safety

The SDK type definitions SHALL enforce publishable key requirement at compile time.

#### Scenario: TypeScript compilation fails without publishable key

- **WHEN** developer writes TypeScript code initializing `ApiClient` without `publishableKey`
- **THEN** TypeScript compiler MUST report a type error
- **AND** the error MUST indicate `publishableKey` is a required property
- **AND** IDE autocomplete MUST show `publishableKey` as a required field

#### Scenario: JavaScript runtime validation

- **WHEN** developer uses SDK in JavaScript (without TypeScript) and omits `publishableKey`
- **THEN** the constructor MUST throw a runtime error immediately
- **AND** the error MUST be thrown before any API requests are made
- **AND** the error message MUST be clear and actionable

#### Scenario: RayfinClientConfig includes auth opt-out flags

- **WHEN** developer initializes `RayfinClient` from `@microsoft/rayfin-client`
- **THEN** `RayfinClientConfig` MUST accept optional `persistSession?: boolean` (default `true`)
- **AND** `RayfinClientConfig` MUST accept optional `autoRefreshToken?: boolean` (default `true`)
- **AND** `RayfinClientConfig` MUST accept optional `multiTabSync?: boolean` (default auto-detected)
- **AND** these options MUST be forwarded to the `Auth` constructor

### Requirement: Session Restoration

Session restoration SHALL include refresh token restoration.

#### Scenario: Session restoration includes refresh token

- **WHEN** the SDK initializes and calls `getInternalSessionFromStorage()`
- **THEN** the method MUST restore the `refreshToken` from storage if present
- **AND** the method MUST handle sessions without refresh tokens gracefully (backward compatibility)
- **AND** the restored session MUST be valid and ready for automatic refresh if access token expires

### Requirement: Multi-Key JWKS Support

The TypeScript Auth SDK SHALL support JWKS responses containing multiple public keys for certificate rollover.

#### Scenario: Token validation with multiple keys in JWKS

- **WHEN** validating an access token
- **AND** the JWKS endpoint returns multiple keys
- **THEN** the SDK MUST find the key matching the token's `kid` claim
- **AND** the SDK MUST use that key for signature verification
- **AND** validation MUST succeed if the signature is valid with the matching key

#### Scenario: Key matching by kid and algorithm

- **WHEN** validating an access token with a specific `kid` in the header
- **AND** the JWKS contains multiple keys with different `kid` values
- **THEN** the SDK MUST match by both `kid` and `alg` claims
- **AND** the SDK MUST NOT use a key with a different `kid` even if `alg` matches

#### Scenario: Graceful handling of missing key

- **WHEN** validating an access token
- **AND** the token's `kid` does not match any key in the JWKS
- **THEN** the SDK MUST log a warning with the unmatched `kid` value
- **AND** the SDK MUST return false for validation
- **AND** the SDK MUST NOT throw an unhandled exception

### Requirement: AuthMethod Extension for Fabric

The `AuthMethod` union type SHALL include `'fabric'` as a recognized authentication method.

> **MODIFIED**: Added `'fabric'` to the `AuthMethod` type and `availableMethods` population.
> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 1 for detailed implementation.

#### Scenario: AuthMethod includes fabric

- **WHEN** a developer imports `AuthMethod` from `@microsoft/rayfin-auth`
- **THEN** the type MUST accept `'password'`, `'magiclink'`, and `'fabric'` as valid values

#### Scenario: Available methods includes fabric when enabled

- **WHEN** the backend returns auth settings with `fabric.enabled: true`
- **THEN** `AuthSettingsConfig.availableMethods` MUST include `'fabric'`
- **AND** `AuthSettingsConfig.fabric.enabled` MUST be `true`

#### Scenario: Available methods excludes fabric when disabled

- **WHEN** the backend returns auth settings with `fabric.enabled: false` or `fabric` is absent
- **THEN** `AuthSettingsConfig.availableMethods` MUST NOT include `'fabric'`

### Requirement: Verification Code Exchange with Code Type

The `exchangeVerificationCode()` method SHALL support an optional `codeType` discriminator to differentiate between magic link and Fabric handoff code exchanges.

> **MODIFIED**: Extended `VerificationCodeExchangeRequest` with optional `codeType` field and updated `exchangeVerificationCode()` to pass it through.
> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 1 for detailed implementation.

#### Scenario: Exchange with codeType for Fabric handoff

- **WHEN** `authApi.exchangeVerificationCode()` is called with `codeType: 'fabric_handoff'`
- **THEN** the request body to `/auth/v1/token` MUST include `codeType: 'fabric_handoff'`
- **AND** the request MUST also include `grantType: 'authorization_code'`, `verificationCode`, `codeVerifier`, and `redirectUri`

#### Scenario: Exchange without codeType for magic link

- **WHEN** `authApi.exchangeVerificationCode()` is called without `codeType`
- **THEN** the request body to `/auth/v1/token` MUST NOT include a `codeType` field
- **AND** the existing magic link exchange behavior MUST be unchanged

#### Scenario: VerificationCodeExchangeRequest type includes optional codeType

- **WHEN** a developer imports `VerificationCodeExchangeRequest` from `@microsoft/rayfin-auth`
- **THEN** the type MUST include an optional `codeType?: string` field
- **AND** existing code that does not set `codeType` MUST continue to compile without changes

### Requirement: Auth Class Extension Points for Companion Providers

The `Auth` class SHALL expose generic extension methods that companion auth provider packages can use for token exchange and session creation.

> **MODIFIED**: Added `getAuthApi()` and `createSessionFromTokenResponse()` as public methods on `Auth`.
> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 1 for detailed implementation.

#### Scenario: getAuthApi returns the AuthApi instance

- **WHEN** a companion provider calls `auth.getAuthApi()`
- **THEN** the returned value MUST be the internal `AuthApi` instance
- **AND** the provider MUST be able to call `exchangeVerificationCode()` on it

#### Scenario: createSessionFromTokenResponse creates a session

- **WHEN** a companion provider calls `auth.createSessionFromTokenResponse(tokenResponse)`
- **THEN** the method MUST decode the JWT access token to extract `userId` and `email`
- **AND** the method MUST create an internal session with the token data
- **AND** the method MUST schedule session expiration based on `expiresIn`
- **AND** the method MUST emit an `AUTH_LOGIN` event
- **AND** the method MUST return an `OpaqueSession`

#### Scenario: Session persisted via AUTH_LOGIN event

- **WHEN** `createSessionFromTokenResponse()` emits `AUTH_LOGIN`
- **THEN** the existing `onSessionChange` listener MUST persist the session to storage
- **AND** no explicit storage call MUST be needed in `createSessionFromTokenResponse()`

### Requirement: AuthApi Public Export

The `AuthApi` class SHALL be exported from the package index so companion providers can reference its type.

> **MODIFIED**: Added `AuthApi` to the package's public exports.
> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 1 for detailed implementation.

#### Scenario: AuthApi importable from package

- **WHEN** a developer imports from `@microsoft/rayfin-auth`
- **THEN** `AuthApi` MUST be available as a named export
- **AND** the type MUST be usable for type annotations in companion provider code
