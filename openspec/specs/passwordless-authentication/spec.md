# Spec: Passwordless Authentication

## Purpose

Define passwordless authentication capabilities for Rayfin, enabling magic link sign-in with PKCE security across backend (WebService), SDK (TypeScript), and CLI configuration.
This establishes an extensible architecture for future passwordless methods like SMS OTP.

## Requirements

### Requirement: Magic Link Authentication Endpoints

The Rayfin WebService SHALL provide magic link passwordless authentication endpoints following OAuth 2.1 authorization_code grant with PKCE.

**ID**: `AUTH-MAGIC-LINK-001`

#### Scenario: Send magic link request succeeds

- **WHEN** a POST request is made to `/auth/v1/magic-link/send`
- **AND** the request body contains valid `email`, `code_challenge`, `state`, and `redirect_uri` fields
- **AND** the `redirect_uri` is in the `allowed_redirect_uris` list from `IProjectSettings`
- **THEN** the endpoint MUST return HTTP 200 OK
- **AND** the response body MUST include `success: true`
- **AND** a magic link email MUST be sent to the provided email address
- **AND** the magic link URL MUST include a single-use verification code and the `state` parameter
- **AND** the `redirect_uri` MUST be stored with the passwordless code record

#### Scenario: Send magic link rejected for disallowed redirect_uri

- **WHEN** a POST request is made to `/auth/v1/magic-link/send`
- **AND** the `redirect_uri` is not in the `allowed_redirect_uris` list from `IProjectSettings`
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `INVALID_REDIRECT_URI`
- **AND** no magic link email MUST be sent

#### Scenario: Send magic link rejected for non-HTTPS redirect_uri

- **WHEN** a POST request is made to `/auth/v1/magic-link/send`
- **AND** the `redirect_uri` uses HTTP scheme (not HTTPS)
- **AND** the host is not `localhost` or `127.0.0.1`
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `HTTPS_REQUIRED`
- **AND** no magic link email MUST be sent

> **Implementation Note:** The `allowed_redirect_uris` configuration is persisted via `/applyProjectRuntimeSettings` API and retrieved from `IProjectSettings` at runtime.

#### Scenario: Send magic link rejected for missing redirect_uri

- **WHEN** a POST request is made to `/auth/v1/magic-link/send`
- **AND** the `redirect_uri` field is missing or empty
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `MISSING_REDIRECT_URI`
- **AND** no magic link email MUST be sent

#### Scenario: Send magic link succeeds for unregistered users

- **WHEN** a POST request is made to `/auth/v1/magic-link/send`
- **AND** the email address does not exist in the system
- **THEN** the endpoint MUST return HTTP 200 OK
- **AND** the response MUST be identical to a request for an existing user
- **AND** a magic link email MUST be sent (user will be created on code exchange)

#### Scenario: Magic link code exchange via token endpoint

- **WHEN** a POST request is made to `/auth/v1/token`
- **AND** `grant_type` is `authorization_code`
- **AND** the request includes valid `verification_code`, `code_verifier`, and `redirect_uri` fields
- **THEN** the endpoint MUST validate the verification_code exists and is not expired
- **AND** the endpoint MUST validate PKCE by computing SHA256(code_verifier) equals stored code_challenge
- **AND** the endpoint MUST validate the `redirect_uri` matches the stored redirect_uri exactly
- **AND** the endpoint MUST mark the verification_code as used
- **AND** the endpoint MUST return access_token, refresh_token, and user information

> **Implementation Note:** The `verification_code` field is used instead of the existing `code` field in `TokenRequest`.
> This separation ensures magic link flows don't conflict with future OAuth authorization code flows (e.g., social login).
> The handler MUST check for mutual exclusivity: exactly one of `verification_code` or `code` may be present.
> When `verification_code` is present → route to magic link exchange (lookup in `passwordless_codes`).
> When `code` is present → route to external OAuth exchange (future: exchange with external provider).
> This design allows apps to simultaneously support magic links AND external OAuth providers (Google, GitHub, etc.).

#### Scenario: Both verification_code and code present returns error

- **WHEN** a POST request is made to `/auth/v1/token` with `grant_type=authorization_code`
- **AND** both `verification_code` and `code` fields are present
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `AMBIGUOUS_CODE_FIELDS`
- **AND** no token exchange MUST occur

#### Scenario: Neither verification_code nor code present returns error

- **WHEN** a POST request is made to `/auth/v1/token` with `grant_type=authorization_code`
- **AND** neither `verification_code` nor `code` field is present
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `MISSING_CODE`
- **AND** no token exchange MUST occur

#### Scenario: Magic link code exchange creates user if not exists

- **WHEN** a magic link verification_code is exchanged via `/auth/v1/token`
- **AND** the email associated with the verification_code does not have a user account
- **THEN** the endpoint MUST create a new user with the email address
- **AND** the user MUST be marked as email_verified
- **AND** tokens MUST be issued for the new user

> **Note:** Auto-registration is always enabled to provide a unified sign-up/sign-in experience.

#### Scenario: Invalid PKCE code_verifier returns error

- **WHEN** a POST request is made to `/auth/v1/token` with `grant_type=authorization_code`
- **AND** the `code_verifier` does not match the stored `code_challenge`
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `INVALID_CODE_VERIFIER`
- **AND** the verification_code MUST NOT be marked as used

#### Scenario: Mismatched redirect_uri returns error

- **WHEN** a POST request is made to `/auth/v1/token` with `grant_type=authorization_code`
- **AND** the `redirect_uri` does not exactly match the stored redirect_uri
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `REDIRECT_URI_MISMATCH`
- **AND** the verification_code MUST NOT be marked as used

#### Scenario: Expired magic link verification_code returns error

- **WHEN** a POST request is made to `/auth/v1/token` with `grant_type=authorization_code`
- **AND** the verification_code has expired
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `CODE_EXPIRED`

#### Scenario: Reused magic link verification_code returns error

- **WHEN** a POST request is made to `/auth/v1/token` with `grant_type=authorization_code`
- **AND** the verification_code has already been used
- **THEN** the endpoint MUST return HTTP 400 Bad Request
- **AND** the response MUST include error code `CODE_ALREADY_USED`

#### Scenario: Anti-virus scanner GET requests do not consume verification_code

- **WHEN** a GET request is made to the magic link callback URL (e.g., by an email security scanner)
- **AND** the request does not include a valid `code_verifier`
- **THEN** the verification_code MUST NOT be marked as used
- **AND** the verification_code MUST remain valid for subsequent legitimate token exchange requests

> **Note:** This ensures resilience against corporate email filters (Outlook/Mimecast) that pre-click links to scan for malware.
> The verification_code is only consumed via POST to `/auth/v1/token` with valid PKCE.

### Requirement: Magic Link Endpoint Security

The magic link endpoints SHALL be accessible without publishable key to enable passwordless flows before app initialization.

**ID**: `AUTH-MAGIC-LINK-002`

#### Scenario: Magic link send endpoint exempted from publishable key

- **WHEN** a request is made to `/auth/v1/magic-link/send`
- **THEN** the middleware MUST skip publishable key validation
- **AND** the endpoint MUST be accessible without publishable key header

### Requirement: Passwordless Code Storage

The WebService SHALL store passwordless codes securely with PKCE support and expiry management. This is separate from the existing `UserTokenRecord` table which handles post-signup flows requiring an existing user.

**ID**: `AUTH-PASSWORDLESS-STORAGE-001`

#### Scenario: Passwordless code stored with PKCE challenge

- **WHEN** a magic link request is processed
- **THEN** a passwordless code record MUST be created
- **AND** the verification_code MUST have at least 128 bits of entropy (cryptographically random)
- **AND** the verification_code MUST be stored as a SHA256 hash (defense-in-depth)
- **AND** the verification_code hash MUST be stored with a unique index
- **AND** the `code_challenge` from the request MUST be stored
- **AND** the `redirect_uri` from the request MUST be stored
- **AND** an expiry timestamp MUST be set based on configuration (default: 15 minutes)

> **Note:** On code exchange, the backend hashes the incoming verification_code and looks up by hash.
> This prevents plaintext code exposure if the database is compromised.

#### Scenario: Maximum active codes per email enforced

- **WHEN** a new magic link is requested for an email address
- **AND** there are already 5 or more unexpired passwordless codes for that email
- **THEN** the oldest unexpired codes MUST be deleted until only 4 remain
- **AND** the new code MUST be created successfully

> **Note:** Multiple active codes are allowed to support concurrent login requests (e.g., user requested links on multiple devices, or resend while first email is delayed).
> PKCE provides security; each code requires the matching `code_verifier` from the originating browser session.
> The limit of 5 bounds database resource usage per email.

#### Scenario: Verification code marked used transactionally

- **WHEN** a verification_code is exchanged for tokens
- **THEN** the code MUST be marked as used in a transaction
- **AND** concurrent exchange attempts for the same code MUST fail (prevent double-spend)
- **AND** the `used_at` timestamp MUST be recorded

#### Scenario: Expired passwordless codes cleaned up

- **WHEN** a background cleanup job runs
- **THEN** passwordless codes past their `expires_at` timestamp MUST be deleted
- **AND** cleanup MUST not affect valid unexpired codes

### Requirement: Magic Link Email Delivery

The WebService SHALL send magic link emails using the configured email provider.

**ID**: `AUTH-MAGIC-EMAIL-001`

#### Scenario: Magic link email sent via configured provider

- **WHEN** a magic link is requested
- **THEN** the email MUST be sent using the configured email provider
- **AND** the email MUST contain a clickable magic link URL
- **AND** the magic link URL MUST use HTTPS for non-localhost redirect URIs
- **AND** the magic link URL MAY use HTTP for localhost or 127.0.0.1 (development only)
- **AND** the email MUST indicate the link expiry time
- **AND** the email MUST use an inline HTML template

#### Scenario: Email delivery failure handled

- **WHEN** the email provider fails to send the magic link email
- **THEN** the failure MUST be logged with error details (excluding verification_code)
- **AND** the endpoint response MUST still return success (consistent response regardless of delivery outcome)
- **AND** the passwordless code record MUST be retained (not deleted) for debugging
- **AND** the code will naturally expire after TTL

#### Scenario: Magic link email includes plaintext and HTML

- **WHEN** a magic link email is sent
- **THEN** the email MUST include both plaintext and HTML parts
- **AND** both parts MUST contain the magic link URL
- **AND** neither part MUST include the code_verifier or code_challenge

### Requirement: SDK Magic Link Authentication

The Rayfin SDK SHALL provide magic link passwordless authentication methods with PKCE security.

> **MODIFIED**: No changes to existing magic link scenarios. The `parseAuthSettings()` method is extended to also parse `fabric` settings from the backend response.

**ID**: `SDK-MAGIC-LINK-001`

#### Scenario: sendMagicLink initiates passwordless flow

- **WHEN** developer calls `auth.sendMagicLink({ email, redirectUri? })`
- **THEN** the SDK MUST generate a cryptographically random `state` (UUID)
- **AND** the SDK MUST generate a cryptographically secure `code_verifier` (43-128 characters)
- **AND** the SDK MUST compute `code_challenge` as base64url(SHA256(code_verifier))
- **AND** the SDK MUST determine `redirect_uri` from parameter or current page URL
- **AND** the SDK MUST store the `code_verifier` and `redirect_uri` in session storage keyed by `rayfin_pkce_{state}`
- **AND** the SDK MUST call `/auth/v1/magic-link/send` with email, code_challenge, state, and redirect_uri
- **AND** the method MUST return a `MagicLinkResult` with success status

#### Scenario: sendMagicLink fires event on success

- **WHEN** `auth.sendMagicLink()` completes successfully
- **THEN** the SDK MUST fire an `AUTH_MAGIC_LINK_SENT` event
- **AND** the event payload MUST include the email address
- **AND** the event MUST NOT include the code_verifier or code_challenge

#### Scenario: sendMagicLink handles server errors

- **WHEN** `auth.sendMagicLink()` receives a non-2xx response
- **THEN** the SDK MUST throw an `AuthError`
- **AND** the error MUST include the server error message
- **AND** the SDK MUST fire an `AUTH_MAGIC_LINK_ERROR` event

#### Scenario: handleMagicLinkCallback exchanges verification_code for tokens

- **WHEN** developer calls `auth.handleMagicLinkCallback()`
- **THEN** the SDK MUST extract `verification_code` and `state` from URL query parameters
- **AND** the SDK MUST retrieve the stored `code_verifier` and `redirect_uri` using key `rayfin_pkce_{state}`
- **AND** the SDK MUST validate the `state` exists in storage
- **AND** the SDK MUST call `/auth/v1/token` with grant_type=authorization_code, verification_code, code_verifier, and redirect_uri
- **AND** on success, the SDK MUST store the session (access_token, refresh_token, user)
- **AND** the method MUST return `{ user, session }`
- **AND** the SDK MUST clear the stored `rayfin_pkce_{state}` key

#### Scenario: handleMagicLinkCallback fires login event

- **WHEN** `auth.handleMagicLinkCallback()` successfully exchanges verification_code for tokens
- **THEN** the SDK MUST fire an `AUTH_LOGIN` event
- **AND** the event payload MUST include the user object
- **AND** the session MUST be stored according to storage configuration

#### Scenario: handleMagicLinkCallback rejects unrecognized state

- **WHEN** `auth.handleMagicLinkCallback()` is called
- **AND** no `code_verifier` is found for the given `state` in session storage
- **THEN** the SDK MUST throw an `AuthError` with message indicating PKCE flow was not initiated from this browser/tab
- **AND** the error MUST guide developers to ensure sendMagicLink was called in the same browser session

> **Note:** The state-keyed storage ensures flow integrity.
> The callback only succeeds if `sendMagicLink()` was called in the same browser session with a matching state.

#### Scenario: handleMagicLinkCallback shows cross-device error

- **WHEN** a user clicks a magic link on a different device than where they initiated the request
- **THEN** the SDK MUST display an error: "This magic link must be opened in the browser where you requested it."
- **AND** the error MUST NOT reveal whether the code is valid or expired
- **AND** the verification_code on the backend MUST NOT be marked as used

#### Scenario: handleMagicLinkCallback handles invalid verification_code

- **WHEN** `auth.handleMagicLinkCallback()` receives an error from token endpoint
- **THEN** the SDK MUST throw an `AuthError` with the server error message
- **AND** the SDK MUST clear the stored `rayfin_pkce_{state}` key
- **AND** the SDK MUST fire an `AUTH_MAGIC_LINK_ERROR` event

### Requirement: SDK Magic Link Helper Utilities

The SDK SHALL provide helper methods for detecting and handling magic link callbacks.

**ID**: `SDK-MAGIC-HELPERS-001`

#### Scenario: isMagicLinkCallback detects callback URL

- **WHEN** developer calls `auth.isMagicLinkCallback()`
- **THEN** the method MUST check the current URL for magic link verification_code parameter
- **AND** the method MUST return `true` if a valid verification_code parameter is present
- **AND** the method MUST return `false` if no verification_code parameter is found
- **AND** the method MUST NOT throw errors for invalid URLs

#### Scenario: getMagicLinkVerificationCode extracts verification_code from URL

- **WHEN** developer calls `auth.getMagicLinkVerificationCode()`
- **AND** the URL contains a magic link verification_code parameter
- **THEN** the method MUST return the verification_code string
- **AND** the method MUST return `null` if no verification_code is present

### Requirement: SDK PKCE Utilities

The SDK SHALL provide PKCE (Proof Key for Code Exchange) utilities for secure code exchange.

**ID**: `SDK-PKCE-001`

#### Scenario: Code verifier generation meets RFC 7636

- **WHEN** the SDK generates a code_verifier internally
- **THEN** the verifier MUST be a random string between 43 and 128 characters
- **AND** the verifier MUST use only unreserved URI characters: [A-Z], [a-z], [0-9], `-`, `.`, `_`, `~`
- **AND** the verifier MUST be cryptographically random

#### Scenario: Code challenge computation is correct

- **WHEN** the SDK computes a code_challenge from a code_verifier
- **THEN** the challenge MUST be computed as: base64url(SHA256(code_verifier))
- **AND** the base64url encoding MUST not include padding characters
- **AND** the computation MUST be deterministic (same verifier produces same challenge)

### Requirement: SDK Magic Link Storage

The SDK SHALL securely store PKCE state during the magic link flow with support for concurrent requests.

**ID**: `SDK-MAGIC-STORAGE-001`

#### Scenario: Code verifier stored via configured AuthStorage

- **WHEN** `auth.sendMagicLink()` is called
- **AND** `this.storage` is not `null`
- **THEN** the code_verifier MUST be stored via `await this.storage.setItem()` under key `{PKCE_STATE_PREFIX}{state}`
- **AND** `window.localStorage` MUST NOT be accessed directly
- **AND** multiple concurrent magic link requests MUST each have independent storage keys

#### Scenario: Code verifier stored in-memory when storage is null

- **WHEN** `auth.sendMagicLink()` is called
- **AND** `this.storage` is `null`
- **THEN** the code_verifier MUST be stored in an in-memory `Map` on the `Auth` instance
- **AND** the flow MUST work within a single page session
- **AND** no error MUST be thrown

#### Scenario: Code verifier cleared after use

- **WHEN** `auth.handleMagicLinkCallback()` completes (success or failure)
- **THEN** the stored PKCE state MUST be cleared via `await this.storage.removeItem()` or from the in-memory `Map`
- **AND** clearing MUST happen even if token exchange fails
- **AND** other pending magic link requests (different state values) MUST NOT be affected

#### Scenario: SDK handles unavailable storage gracefully

- **WHEN** `auth.sendMagicLink()` is called
- **AND** `this.storage` is `null` (e.g., `storage: false` or Node.js without custom storage)
- **THEN** the SDK MUST use the in-memory PKCE state fallback
- **AND** the SDK MUST NOT throw an error about localStorage or sessionStorage availability

#### Scenario: Concurrent magic link requests work independently

- **WHEN** developer calls `auth.sendMagicLink({ email: "alice@example.com" })`
- **AND** developer then calls `auth.sendMagicLink({ email: "bob@example.com" })`
- **THEN** both requests MUST have independent `state` and `code_verifier` values
- **AND** clicking Alice's magic link MUST successfully authenticate using Alice's code_verifier
- **AND** clicking Bob's magic link MUST successfully authenticate using Bob's code_verifier
- **AND** neither request MUST interfere with the other

### Requirement: SDK Magic Link Type Definitions

The SDK type definitions SHALL include magic link types for TypeScript developers.

**ID**: `SDK-MAGIC-TYPES-001`

#### Scenario: MagicLinkOptions type defined

- **WHEN** developer uses TypeScript with the SDK
- **THEN** `MagicLinkOptions` type MUST be available
- **AND** the type MUST include required `email: string` property
- **AND** the type MUST include optional `redirectUri?: string` property

#### Scenario: MagicLinkResult type defined

- **WHEN** `auth.sendMagicLink()` returns
- **THEN** the return type MUST be `MagicLinkResult`
- **AND** the type MUST include `success: boolean` property
- **AND** the type MUST include optional `message?: string` property

#### Scenario: Auth events include magic link events

- **WHEN** developer subscribes to auth events
- **THEN** `AUTH_MAGIC_LINK_SENT` event type MUST be available
- **AND** `AUTH_MAGIC_LINK_ERROR` event type MUST be available
- **AND** event payloads MUST be properly typed

### Requirement: CLI Passwordless Configuration Schema

The Rayfin CLI SHALL support passwordless authentication configuration in `rayfin.yml`.

**ID**: `CLI-PASSWORDLESS-001`

#### Scenario: Magic link configuration in rayfin.yml

- **WHEN** developer configures `services.auth.passwordless.magic_link` in `rayfin.yml`
- **THEN** the CLI MUST recognize and validate the following properties:
  - `enabled`: boolean (default: false)
  - `callback_path`: string (default: /auth/callback)
  - `allowed_redirect_uris`: array of valid URL strings (required when enabled)
- **AND** the CLI MUST pass configuration to the WebService container via `/applyProjectRuntimeSettings` API

> **Note:** Auto-registration is always enabled (not configurable) to provide a unified sign-up/sign-in experience.

#### Scenario: Allowed redirect URIs validation

- **WHEN** developer configures `services.auth.passwordless.magic_link.allowed_redirect_uris`
- **AND** any entry is not a valid URL (http or https)
- **THEN** the CLI MUST emit a validation error
- **AND** the error message MUST indicate which URI is invalid

#### Scenario: SMS OTP configuration placeholder in rayfin.yml

- **WHEN** developer configures `services.auth.passwordless.sms_otp` in `rayfin.yml`
- **THEN** the CLI MUST recognize and validate the following properties:
  - `enabled`: boolean (default: false)
  - `provider`: string enum (reserved for future: 'twilio', 'vonage', etc.)
  - `otp_length`: integer 4-8 (default: 6)
  - `expiry_minutes`: positive integer (default: 5)
  - `max_attempts`: positive integer (default: 3)
- **AND** the CLI MUST warn that SMS OTP is not yet implemented if `enabled: true`

#### Scenario: Passwordless requires email configuration

- **WHEN** developer enables `services.auth.passwordless.magic_link.enabled: true`
- **AND** `services.auth.email.enabled` is `false` or not configured
- **THEN** the CLI MUST emit a validation error
- **AND** the error message MUST indicate that email provider is required for magic links

#### Scenario: Default passwordless configuration generated

- **WHEN** developer runs `rayfin init` or generates auth configuration
- **THEN** the generated `rayfin.yml` MUST include a `passwordless` section under `services.auth`
- **AND** the default configuration MUST have `magic_link.enabled: false`
- **AND** the default configuration MUST have `sms_otp.enabled: false`

### Requirement: CLI Passwordless Configuration Validation

The CLI SHALL validate passwordless configuration during `rayfin dev` and `rayfin build`.

**ID**: `CLI-PASSWORDLESS-002`

#### Scenario: Valid magic link configuration accepted

- **WHEN** `rayfin dev` or `rayfin build` is run
- **AND** `services.auth.passwordless.magic_link` has valid configuration
- **THEN** the CLI MUST accept the configuration without errors
- **AND** the CLI MUST pass passwordless settings to the WebService

#### Scenario: Both password and passwordless disabled warning

- **WHEN** `services.auth.enabled: true`
- **AND** `services.auth.passwordless.magic_link.enabled: false`
- **AND** `services.auth.passwordless.sms_otp.enabled: false`
- **AND** no password-based authentication is configured
- **THEN** the CLI MUST emit a warning that no authentication methods are enabled

### Requirement: CLI Environment Variable Support for Passwordless

The CLI SHALL support environment variable interpolation for passwordless settings.

**ID**: `CLI-PASSWORDLESS-003`

#### Scenario: Passwordless settings from environment variables

- **WHEN** developer uses environment variable syntax in passwordless configuration:

```yaml
services:
  auth:
    passwordless:
      magic_link:
        enabled: ${MAGIC_LINK_ENABLED:-false}
        callback_path: ${MAGIC_LINK_CALLBACK:-/auth/callback}
        allowed_redirect_uris:
          - ${APP_URL:-http://localhost:5173}
```

- **THEN** the CLI MUST resolve environment variables at runtime
- **AND** default values MUST be applied if variables are not set
- **AND** type coercion MUST be applied (string "true" → boolean true)

### Requirement: Auth Settings Parsing Includes Fabric

The `parseAuthSettings()` method SHALL parse the `fabric` block from backend auth settings alongside the existing `password` and `passwordless` blocks.

> **MODIFIED**: Extended `parseAuthSettings()` and `ProjectRuntimeSettingsResponse` to include `fabric` configuration.
> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 1b for `parseAuthSettings()` extension.

#### Scenario: Backend returns fabric settings

- **WHEN** `parseAuthSettings()` processes a backend response containing `serviceSettings.auth.fabric.enabled: true`
- **THEN** the returned `AuthSettingsConfig` MUST include `fabric: { enabled: true }`
- **AND** `availableMethods` MUST include `'fabric'`

#### Scenario: Backend omits fabric settings

- **WHEN** `parseAuthSettings()` processes a backend response without a `fabric` block
- **THEN** the returned `AuthSettingsConfig` MUST include `fabric: { enabled: false }`
- **AND** `availableMethods` MUST NOT include `'fabric'`

#### Scenario: Fabric settings coexist with password and passwordless

- **WHEN** the backend returns `password.enabled: true`, `passwordless.magicLink.enabled: true`, and `fabric.enabled: true`
- **THEN** `availableMethods` MUST be `['password', 'magiclink', 'fabric']`
- **AND** all three blocks MUST be present in the returned config

### Requirement: AuthSettingsConfig Type Extension

The `AuthSettingsConfig` interface SHALL include an optional `fabric` settings block.

> **MODIFIED**: Added `fabric?: { enabled: boolean }` to the `AuthSettingsConfig` type.
> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 1b for `parseAuthSettings()` extension.

#### Scenario: AuthSettingsConfig type includes fabric

- **WHEN** a developer imports `AuthSettingsConfig` from `@microsoft/rayfin-auth`
- **THEN** the type MUST include an optional `fabric?: { enabled: boolean }` field
- **AND** existing code that does not reference `fabric` MUST continue to compile without changes
