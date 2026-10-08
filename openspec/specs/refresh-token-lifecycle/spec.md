# refresh-token-lifecycle Specification

## Purpose

TBD - created by archiving change add-counter-based-refresh-tokens. Update Purpose after archive.

## Requirements

### Requirement: Refresh Token Generation

The Rayfin Auth service SHALL generate refresh tokens using asymmetric signing via the `IKeyProvider.SignAsync()` method.

#### Scenario: Token generated on password grant with provider signing

- **WHEN** a user successfully authenticates via password grant (login or signup)
- **THEN** the system MUST generate a refresh token with format `rayfin_rt_<base64url(payload)>.<base64url(signature)>.<kid>`
- **AND** the payload MUST contain the session ID (16 bytes UUID) and creation timestamp (8 bytes bigint UTC Unix milliseconds)
- **AND** the payload MUST be signed using `IKeyProvider.SignAsync()` (not direct private key access)
- **AND** the signature algorithm MUST match the configured algorithm (ES256, RS256, etc.)
- **AND** the `kid` MUST be obtained from `IKeyProvider.GetCurrentKeyIdAsync()`

#### Scenario: Token stored with session

- **WHEN** a refresh token is generated
- **THEN** the session's `LastRefreshTokenAt` MUST be set to the token's creation timestamp (UTC Unix milliseconds)
- **AND** the session's `ExpiresAt` MUST be set to NOW() + configured lifetime (default 90 days)
- **AND** all timestamps MUST be stored as BIGINT in UTC Unix milliseconds in the database

#### Scenario: Token format with provider signing

- **WHEN** a refresh token is generated
- **THEN** the token MUST be integrity-protected via asymmetric signature (not encrypted)
- **AND** the signature MUST be generated via `IKeyProvider.SignAsync()` (supporting remote HSM or local signing)
- **AND** the `kid` MUST be appended as the third component for key identification
- **AND** the token MUST maintain the `rayfin_rt_` prefix for identification

### Requirement: Refresh Token Validation

The Rayfin Auth service SHALL validate refresh tokens using signature verification with cached public keys from `IKeyProvider.GetPublicKeysAsync()`.

#### Scenario: Valid signed token passes all checks

- **WHEN** a signed refresh token is submitted for validation
- **THEN** the system MUST parse the token to extract payload, signature, and `kid`
- **AND** the system MUST resolve the public key by matching `kid` against keys from `IKeyProvider.GetPublicKeysAsync()`
- **AND** the system MUST reject immediately if `kid` does not match any cached key (do NOT fetch from Key Vault)
- **AND** the system MUST verify the asymmetric signature using the resolved public key
- **AND** the system MUST deserialize the session ID and timestamp from the payload
- **AND** the system MUST query the Sessions table for the session ID
- **AND** the system MUST verify the session exists and is not expired
- **AND** the system MUST verify the user exists and is not disabled
- **AND** the system MUST compare the token's timestamp with the session's `LastRefreshTokenAt`

#### Scenario: Unknown kid fails validation

- **WHEN** a refresh token has a `kid` that does not match any key from `IKeyProvider.GetPublicKeysAsync()`
- **THEN** the system MUST reject the token immediately without querying Key Vault
- **AND** the system MUST log a security warning with the unknown `kid` value
- **AND** the system MUST return 401 with error code `invalid_grant`
- **AND** the system MUST NOT attempt to fetch the key from Key Vault (DoS prevention)

#### Scenario: Invalid signature fails validation

- **WHEN** a refresh token has an invalid asymmetric signature
- **THEN** the system MUST reject the token
- **AND** the system MUST log a security warning with the error details
- **AND** the system MUST return 401 with error code `invalid_grant`
- **AND** the system MUST NOT revoke the session (likely forged token)

#### Scenario: Non-existent session fails validation

- **WHEN** a refresh token's session ID does not exist in the database
- **THEN** the system MUST reject the token
- **AND** the system MUST return 401 with error code `invalid_grant`
- **AND** the system MUST log the failed validation attempt

#### Scenario: Expired session fails validation

- **WHEN** a refresh token's session has passed its `ExpiresAt` timestamp
- **THEN** the system MUST reject the token
- **AND** the system MUST return 401 with error code `invalid_grant`
- **AND** the system MUST include a message indicating the session has expired

#### Scenario: Disabled user fails validation

- **WHEN** a refresh token's user account is disabled or deleted
- **THEN** the system MUST reject the token
- **AND** the system MUST return 401 with error code `invalid_grant`
- **AND** the system MUST NOT allow access even with a valid token

### Requirement: Refresh Token Rotation

The system SHALL automatically rotate refresh tokens on every successful refresh to maintain OAuth 2.1 compliance.

#### Scenario: Current token triggers rotation

- **WHEN** a refresh token's timestamp exactly matches the session's `LastRefreshTokenAt`
- **THEN** the system MUST generate a new refresh token with the same session ID and a new timestamp
- **AND** the system MUST update the session's `LastRefreshTokenAt` to the new timestamp
- **AND** the system MUST extend the session's `ExpiresAt` to NOW() + configured lifetime
- **AND** the system MUST generate a new access token (JWT)
- **AND** the system MUST return both the new access token and new refresh token

#### Scenario: Old token becomes invalid after rotation

- **WHEN** a refresh token is successfully used and rotated
- **THEN** the old refresh token MUST become invalid immediately
- **AND** any subsequent use of the old token MUST fail validation (timestamp mismatch)
- **AND** use outside the reuse window MUST be treated as a replay attack

### Requirement: Replay Attack Detection

The system SHALL detect replay attacks by comparing token timestamps with a configurable reuse window.

#### Scenario: Token outside reuse window triggers revocation

- **WHEN** a refresh token's timestamp is older than `LastRefreshTokenAt`
- **AND** the time difference (`LastRefreshTokenAt - token.timestamp`) is greater than the reuse interval (default 10 seconds)
- **THEN** the system MUST treat this as a replay attack
- **AND** the system MUST delete the session from the database immediately
- **AND** the system MUST log a security event (WARNING level) with session ID, user ID, and timestamp difference
- **AND** the system MUST return 401 with error code `invalid_grant` and a generic message
- **AND** all browser tabs using this session MUST be logged out

#### Scenario: Token within reuse window is a legitimate retry

- **WHEN** a refresh token's timestamp is older than `LastRefreshTokenAt`
- **AND** the time difference is less than or equal to the reuse interval (default 10 seconds)
- **THEN** the system MUST treat this as a legitimate retry (e.g., network timeout, multi-tab concurrent refresh)
- **AND** the system MUST return the most recently generated tokens WITHOUT generating new ones
- **AND** the system MUST NOT update the session's `LastRefreshTokenAt` timestamp
- **AND** the system MUST log an informational event indicating reuse detected

#### Scenario: Future timestamp revokes session

- **WHEN** a refresh token's timestamp is greater than `LastRefreshTokenAt` (future timestamp)
- **THEN** the system MUST treat this as a security threat (forged or tampered token)
- **AND** the system MUST delete the session from the database immediately
- **AND** the system MUST return 401 with error code `invalid_grant`
- **AND** the system MUST log a security warning with message "Refresh token has future timestamp - possible token forgery or clock skew attack"
- **AND** the log MUST include session ID, user ID, token timestamp, and session LastRefreshTokenAt for investigation

### Requirement: Refresh Token Revocation

The system SHALL revoke refresh tokens through session deletion, supporting logout, replay attacks, and user account deletion.

#### Scenario: Logout revokes refresh token

- **WHEN** a user logs out via POST `/api/auth/v1/signout`
- **THEN** the system MUST delete the session from the database
- **AND** any refresh tokens for that session MUST become invalid immediately
- **AND** subsequent refresh attempts MUST return 401 with error code `invalid_grant`

#### Scenario: Replay attack revokes all session tokens

- **WHEN** a replay attack is detected (token outside reuse window)
- **THEN** the system MUST delete the entire session
- **AND** the access token MUST be invalidated (JWT expiration still applies, but session lookup fails)
- **AND** the refresh token MUST be invalidated (session no longer exists)
- **AND** all browser tabs using this session MUST lose access

#### Scenario: User deletion cascades to sessions

- **WHEN** a user account is deleted from the database
- **THEN** all sessions for that user MUST be deleted (ON DELETE CASCADE)
- **AND** all refresh tokens for those sessions MUST become invalid
- **AND** no orphaned sessions MUST remain in the database

#### Scenario: Session expiration prevents refresh

- **WHEN** a session's `ExpiresAt` timestamp has passed
- **THEN** refresh attempts MUST return 401 with error code `invalid_grant`
- **AND** the expired session MUST be eligible for cleanup by the background service
- **AND** users MUST be required to log in again

### Requirement: Session Cleanup Service

The system SHALL run a background service to delete expired sessions periodically.

#### Scenario: Cleanup service runs on schedule

- **WHEN** the cleanup service is running
- **THEN** the service MUST run every configured interval (default 6 hours)
- **AND** the service MUST query for sessions where `ExpiresAt < NOW()`
- **AND** the service MUST delete expired sessions in batches (default 1000 per batch)
- **AND** the service MUST log the number of sessions deleted and execution duration

#### Scenario: Cleanup service handles errors gracefully

- **WHEN** the cleanup service encounters a database error
- **THEN** the service MUST log the error with stack trace
- **AND** the service MUST continue running (not crash)
- **AND** the service MUST retry on the next scheduled interval

#### Scenario: Cleanup respects cancellation token

- **WHEN** the WebService is shutting down
- **THEN** the cleanup service MUST respect the cancellation token
- **AND** the service MUST stop gracefully without blocking shutdown
- **AND** the current batch MUST complete or be rolled back

### Requirement: Refresh Token Security Logging

The system SHALL log all refresh token lifecycle events for security monitoring and audit trails.

#### Scenario: Successful refresh logged

- **WHEN** a refresh token is successfully used and rotated
- **THEN** the system MUST log an informational event
- **AND** the log MUST include session ID, user ID, and timestamp
- **AND** the log MUST use structured logging for query-friendly output

#### Scenario: Replay attack logged

- **WHEN** a replay attack is detected
- **THEN** the system MUST log a warning event
- **AND** the log MUST include session ID, user ID, timestamp difference, and "session revoked" indicator
- **AND** the log MUST include correlation ID for tracing

#### Scenario: Legitimate reuse logged

- **WHEN** a token within the reuse window is used
- **THEN** the system MUST log an informational event
- **AND** the log MUST include the time difference and "reuse detected" indicator

#### Scenario: Invalid token logged

- **WHEN** an invalid token is presented (signature/decryption failure)
- **THEN** the system MUST log a security warning
- **AND** the log MUST include error details but NOT the full token
- **AND** the log MUST include the token prefix for identification

### Requirement: Certificate-Based Key Resolution

The Rayfin Auth service SHALL resolve signing keys using certificate thumbprint as key identifier.

#### Scenario: Active certificate used for signing

- **WHEN** a new refresh token is generated
- **THEN** the system MUST use the active certificate (latest `NotBefore` date) for signing
- **AND** the `kid` in the token MUST be derived from the active certificate's public key using SHA-256

#### Scenario: Previous certificate valid for verification

- **WHEN** a refresh token is validated with a `kid` matching the previous certificate's key hash
- **THEN** the system MUST use the previous certificate's public key for signature verification
- **AND** validation MUST succeed if the signature is valid and session state checks pass

#### Scenario: Rollover window support

- **WHEN** certificates are rotated in Key Vault
- **THEN** the system MUST maintain both active and previous certificates in the cache
- **AND** tokens signed with either certificate MUST be valid for verification
- **AND** new tokens MUST be signed with the active certificate only
