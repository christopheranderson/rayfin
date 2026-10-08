# webservice-api-security Specification

## Purpose

TBD - created by archiving change add-publishable-key-authentication. Update Purpose after archive.

## Requirements

### Requirement: Publishable Key Format

The WebService SHALL generate publishable keys with a fixed format and cryptographically secure entropy so downstream validation, logging, and key-rotation logic can rely on a stable contract.

#### Scenario: Generated publishable key matches the canonical format

- **WHEN** the host generates a publishable key (e.g. via `PublishableKeyGenerator.Generate()`)
- **THEN** the key MUST start with the prefix `pk-`
- **AND** the key MUST be followed by exactly 20 characters drawn from the alphabet `[A-Za-z0-9-]`
- **AND** the key MUST be generated using a cryptographically secure random number generator (CSPRNG)
- **AND** the key MUST provide at least ~119 bits of entropy

### Requirement: Publishable Key Validation Middleware

The Rayfin WebService SHALL validate publishable keys on all data plane API requests to ensure only authorized clients can access the service.

#### Scenario: Valid publishable key allows request

- **WHEN** a request includes `X-Publishable-Key` header with the correct key value
- **THEN** the middleware allows the request to proceed to the next middleware
- **AND** the request continues through authentication and authorization
- **AND** no error response is generated

#### Scenario: Missing publishable key returns 401

- **WHEN** a request to a protected endpoint does not include `X-Publishable-Key` header
- **THEN** the middleware MUST return HTTP 401 Unauthorized
- **AND** the response body MUST include error code `MISSING_PUBLISHABLE_KEY`
- **AND** the response body MUST include a message: "X-Publishable-Key header is required"
- **AND** the request MUST NOT proceed to subsequent middleware

#### Scenario: Invalid publishable key returns 401

- **WHEN** a request includes `X-Publishable-Key` header with an incorrect key value
- **THEN** the middleware MUST return HTTP 401 Unauthorized
- **AND** the response body MUST include error code `INVALID_PUBLISHABLE_KEY`
- **AND** the response body MUST include a message indicating the key is invalid
- **AND** the request MUST NOT proceed to subsequent middleware

### Requirement: Exempt Endpoints Configuration

The middleware SHALL exempt control plane and public endpoints from publishable key validation.

#### Scenario: Health check endpoint exempted

- **WHEN** a request is made to `/healthcheck`
- **THEN** the middleware MUST skip publishable key validation
- **AND** the request MUST proceed regardless of header presence

#### Scenario: JWKS endpoint exempted

- **WHEN** a request is made to `/.well-known/jwks.json`
- **THEN** the middleware MUST skip publishable key validation
- **AND** the endpoint MUST be accessible without publishable key

#### Scenario: Swagger UI exempted

- **WHEN** a request is made to any path under `/swagger/`
- **THEN** the middleware MUST skip publishable key validation
- **AND** Swagger documentation MUST be accessible without publishable key

#### Scenario: DAB config endpoints exempted

- **WHEN** a request is made to `/api/data/config/**` paths
- **THEN** the middleware MUST skip publishable key validation
- **AND** CLI tools can apply configuration without publishable key

#### Scenario: Storage config endpoint exempted

- **WHEN** a request is made to `/api/applystorageconfig`
- **THEN** the middleware MUST skip publishable key validation
- **AND** the request MUST proceed regardless of header presence

### Requirement: WebService Startup Validation

The WebService SHALL validate publishable key configuration at startup and fail to start if not configured.

#### Scenario: Service fails to start without publishable key

- **WHEN** the WebService starts and `PUBLISHABLE_KEY` environment variable is not set
- **THEN** the service MUST fail to start immediately
- **AND** a clear error message MUST be logged indicating the missing configuration
- **AND** the error MUST specify the environment variable name: `PUBLISHABLE_KEY`

#### Scenario: Service fails with empty publishable key

- **WHEN** the WebService starts and `PUBLISHABLE_KEY` environment variable is empty or whitespace
- **THEN** the service MUST fail to start
- **AND** the error message MUST indicate that a non-empty value is required

#### Scenario: Service starts successfully with valid key

- **WHEN** the WebService starts and `PUBLISHABLE_KEY` environment variable contains a valid key
- **THEN** the service MUST start successfully
- **AND** the middleware MUST be configured to validate against the configured key
- **AND** the key value MUST be logged (partial value for security) confirming configuration

### Requirement: Middleware Pipeline Order

The publishable key validation middleware SHALL execute before authentication middleware.

#### Scenario: Middleware executes early in pipeline

- **WHEN** a request enters the middleware pipeline
- **THEN** publishable key validation MUST occur after CORS middleware
- **AND** publishable key validation MUST occur before `RayfinAuthenticationMiddleware`
- **AND** publishable key validation MUST occur before authorization checks

#### Scenario: Early rejection reduces processing overhead

- **WHEN** a request has an invalid or missing publishable key
- **THEN** the request MUST be rejected before JWT token validation
- **AND** the request MUST be rejected before any database queries
- **AND** no unnecessary resources are consumed

### Requirement: AllowAnonymous Endpoints Require Publishable Key

The publishable key validation SHALL apply to all endpoints including those marked with `[AllowAnonymous]` attribute.

#### Scenario: AllowAnonymous endpoints still require publishable key

- **WHEN** a request is made to an endpoint with `[AllowAnonymous]` attribute
- **AND** the request does not include a valid `X-Publishable-Key` header
- **THEN** the middleware MUST return HTTP 401 Unauthorized with error code `MISSING_PUBLISHABLE_KEY`
- **AND** the request MUST NOT reach the JWT authentication middleware or controller

#### Scenario: Anonymous user with valid publishable key accessing AllowAnonymous endpoint

- **WHEN** a request includes valid `X-Publishable-Key` but no JWT token
- **AND** the endpoint has `[AllowAnonymous]` attribute
- **THEN** the publishable key middleware allows the request to proceed
- **AND** JWT middleware assigns anonymous claims (`sub="anonymous"`, `role="anonymous"`)
- **AND** the controller receives the request successfully

### Requirement: Password Grant Refresh Token Response

The password grant response SHALL include a signed refresh token using the unified signing certificate.

#### Scenario: Password grant returns signed refresh token

- **WHEN** a POST request to `/api/auth/v1/token` with `grant_type=password` succeeds
- **THEN** the response MUST include a `refresh_token` field
- **AND** the `refresh_token` MUST be a signed, integrity-protected token
- **AND** the `refresh_token` MUST have the format `rayfin_rt_<base64url(payload)>.<base64url(signature)>.<kid>`
- **AND** the `kid` MUST be the signing certificate's thumbprint
- **AND** the session's `LastRefreshTokenAt` MUST be set to the token's creation timestamp

### Requirement: Publishable Key API Endpoint

The WebService SHALL expose a public API endpoint that returns the current publishable key without requiring authentication or publishable key validation.

**ID**: `WEBAPI-PUBKEY-ENDPOINT-001`

**Priority**: High

#### Scenario: Successful publishable key retrieval

- **GIVEN** the WebService is running and initialized with a publishable key
- **WHEN** a client makes a GET request to `/api/publishable-key`
- **THEN** the endpoint SHALL return HTTP 200 OK
- **AND** the response body SHALL be JSON with structure: `{ "publishableKey": "<key-value>" }`
- **AND** the `publishableKey` value SHALL match the key configured in `IProjectContext`
- **AND** the endpoint SHALL NOT require `X-Publishable-Key` header
- **AND** the endpoint SHALL NOT require authentication

#### Scenario: Publishable key endpoint exempt from validation

- **GIVEN** the PublishableKeyValidationMiddleware is active
- **WHEN** a request is made to `/api/publishable-key` without `X-Publishable-Key` header
- **THEN** the middleware SHALL skip validation for this endpoint
- **AND** the request SHALL proceed to the controller
- **AND** no 401 Unauthorized response SHALL be returned

#### Scenario: Service not initialized returns 503

- **GIVEN** the WebService is running but `IProjectContext` is not properly initialized
- **WHEN** a client makes a GET request to `/api/publishable-key`
- **THEN** the endpoint SHALL return HTTP 503 Service Unavailable
- **AND** the response body SHALL include an error message indicating the service is not ready
- **AND** the response SHALL be JSON formatted

#### Scenario: CORS handling for local development

- **GIVEN** a client makes a request from a different origin (e.g., localhost:3000)
- **WHEN** the request is made to `/api/publishable-key`
- **THEN** the endpoint SHALL respect the WebService's CORS configuration
- **AND** SHALL return appropriate CORS headers for allowed origins

### Requirement: Response Format Consistency

The publishable key endpoint SHALL use a consistent JSON response format for all success and error cases.

**ID**: `WEBAPI-PUBKEY-FORMAT-001`

**Priority**: Medium

#### Scenario: Success response format

- **GIVEN** a successful request to `/api/publishable-key`
- **WHEN** the response is returned
- **THEN** the Content-Type SHALL be `application/json`
- **AND** the response body SHALL contain only the `publishableKey` field
- **AND** the publishable key value SHALL be a non-empty string

#### Scenario: Error response format

- **GIVEN** an error occurs during publishable key retrieval
- **WHEN** the error response is returned
- **THEN** the Content-Type SHALL be `application/json`
- **AND** the response body SHALL contain an `error` field with a descriptive message
- **AND** the response SHALL NOT expose internal implementation details or stack traces

### Requirement: JWKS Endpoint Multi-Key Support

The JWKS endpoint SHALL return multiple public keys to support certificate rollover.

#### Scenario: JWKS returns active and previous keys during rollover

- **WHEN** a GET request is made to `/.well-known/jwks.json`
- **AND** both active and previous certificates are available in the certificate cache
- **THEN** the response MUST include public keys for both certificates
- **AND** each key MUST have a unique `kid` (certificate thumbprint)
- **AND** the keys MUST be ordered with active key first

#### Scenario: JWKS returns single key when no previous certificate

- **WHEN** a GET request is made to `/.well-known/jwks.json`
- **AND** only the active certificate is available (no previous certificate)
- **THEN** the response MUST include only the active certificate's public key
- **AND** the key MUST have `kid` set to the certificate thumbprint

#### Scenario: JWKS cache alignment with certificate cache

- **WHEN** the certificate cache is refreshed with new certificates
- **THEN** the JWKS response cache SHOULD be invalidated
- **AND** subsequent JWKS requests MUST return the updated public keys
