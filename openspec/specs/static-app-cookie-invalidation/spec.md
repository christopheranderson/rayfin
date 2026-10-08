# static-app-cookie-invalidation Specification

## Purpose

Defines when the static-hosting serve cookie is cleared from the browser and when it is deliberately
left in place.

The distinction matters because the two failure modes are not symmetric. Leaving a permanently dead
cookie in the jar costs a signature verification on every subsequent request until it expires.
Clearing a cookie that is only momentarily unverifiable - a key-ring fault, a session-store blip -
is far worse: it converts a transient dependency failure into a forced re-authentication for every
live session at once.

This capability therefore classifies each unusable-cookie state as definitive or transient, and
requires that the deletion header be byte-compatible with the header that minted the cookie, since a
`__Host-` + `Partitioned` cookie is only cleared when every attribute matches.

## Requirements

### Requirement: Unusable serve cookie states are classified as definitive or transient

When the static-hosting access gate determines that a present serve cookie cannot authorize the request, it SHALL classify the outcome as either definitive or transient before deciding whether to clear the cookie.

A state SHALL be classified definitive only when the cookie itself can never again authorize a request. A state SHALL be classified transient when the gate was unable to complete the evaluation for reasons outside the cookie's validity.

Any newly introduced rejection condition SHALL default to transient unless explicitly classified as definitive.

#### Scenario: Cryptographic and binding failures are definitive

- **WHEN** the cookie signature fails verification, or its key identifier is unknown
- **OR** the cookie is past its expiry, or past its absolute lifetime cap
- **OR** the cookie's host binding does not match the server-derived canonical host
- **OR** the cookie's posture binding does not match the effective posture
- **THEN** the gate SHALL classify the outcome as definitive

#### Scenario: Revoked bound session is definitive

- **WHEN** the cookie passes verification but its bound Rayfin session is absent, unauthenticated, or expired in the session store
- **THEN** the gate SHALL classify the outcome as definitive

#### Scenario: Server-side evaluation failures are transient

- **WHEN** the server-derived canonical host cannot be resolved
- **OR** the bound-session lookup raises an error
- **OR** the session identifier cannot be read from a cookie that otherwise passed verification
- **THEN** the gate SHALL classify the outcome as transient

#### Scenario: Both classes still deny the request

- **WHEN** the gate classifies an outcome as either definitive or transient
- **THEN** the request SHALL NOT be served from the cookie
- **AND** the two classes SHALL differ only in whether the cookie is cleared

### Requirement: The serve cookie is cleared on definitive rejection

When the gate classifies a rejection as definitive, it SHALL emit a cookie-deletion `Set-Cookie` header on the response that carries the rejection.

#### Scenario: Definitive rejection on a document request clears the cookie

- **WHEN** a document request presents a cookie that is definitively rejected
- **THEN** the response SHALL include a deletion `Set-Cookie` header for the serve cookie
- **AND** the response body SHALL be the same no-credential response the request would have received with no cookie present

#### Scenario: Definitive rejection on an asset request clears the cookie

- **WHEN** an asset request presents a cookie that is definitively rejected
- **THEN** the response SHALL include a deletion `Set-Cookie` header for the serve cookie
- **AND** the response SHALL be the same unauthorized response the request would have received with no cookie present

#### Scenario: A subsequent request carries no cookie

- **WHEN** a browser has processed a deletion header for the serve cookie
- **THEN** the next request to the same app SHALL NOT present the serve cookie
- **AND** the gate SHALL evaluate that request through its no-cookie path without performing a signature verification or a bound-session lookup

### Requirement: The serve cookie is preserved on transient rejection

When the gate classifies a rejection as transient, it SHALL NOT emit a cookie-deletion header.

#### Scenario: Canonical host resolution failure preserves the cookie

- **WHEN** the server-derived canonical host cannot be resolved and the request is denied
- **THEN** the response SHALL NOT include a deletion `Set-Cookie` header for the serve cookie
- **AND** a later request made after the condition clears SHALL be able to authorize from the same cookie

#### Scenario: Session-store fault preserves the cookie

- **WHEN** the bound-session lookup raises an error and the request is denied
- **THEN** the response SHALL NOT include a deletion `Set-Cookie` header for the serve cookie

### Requirement: The deletion header matches the mint attributes exactly

The deletion header SHALL be produced by the same component that mints the serve cookie, from a single shared attribute definition, so that mint and deletion attributes cannot diverge.

The deletion header SHALL carry an empty value, an immediate expiry, and the identical `HttpOnly`, `Secure`, `SameSite`, partitioning, and `Path` attributes used at mint, and SHALL NOT carry a `Domain` attribute.

#### Scenario: Deletion header attribute parity

- **WHEN** the cookie service produces a deletion header
- **THEN** the header SHALL specify `Path=/`, `HttpOnly`, `Secure`, `SameSite=None`, and the partitioned attribute
- **AND** the header SHALL NOT specify a `Domain` attribute
- **AND** the attribute set SHALL be identical to the attribute set used when minting the cookie

#### Scenario: Deletion is effective for a partitioned cookie

- **WHEN** a serve cookie was stored in a partitioned cookie jar under an embedded top-level site
- **AND** the gate emits a deletion header for that cookie
- **THEN** the browser SHALL remove the partitioned cookie
- **AND** the next request from that partition SHALL NOT present the serve cookie

### Requirement: Cookie clearing is observable in gate telemetry

The gate SHALL record whether a rejection cleared the cookie, and SHALL record the classified rejection condition, in its existing per-invocation telemetry record.

#### Scenario: Definitive rejection is recorded with its condition

- **WHEN** the gate definitively rejects a cookie and emits a deletion header
- **THEN** the telemetry record SHALL indicate that the cookie was cleared
- **AND** the record SHALL identify which rejection condition applied

#### Scenario: Transient rejection is distinguishable from definitive rejection

- **WHEN** the gate transiently rejects a cookie
- **THEN** the telemetry record SHALL indicate that the cookie was not cleared
- **AND** the record SHALL be distinguishable from a definitive rejection of the same request shape

#### Scenario: Telemetry excludes cookie and identity material

- **WHEN** the gate records any rejection
- **THEN** the record SHALL NOT contain the cookie value, its signature, its payload, or any raw user identifier
