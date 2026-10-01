# embedded-identity-continuity Specification

## Purpose

Defines how a Fabric-embedded static app determines whether an existing app session belongs to the
Fabric user currently looking at it.

The embedded iframe and the app session have independent lifetimes, so a still-valid session can
outlive the sign-in it was created for. Without a continuity signal the only safe option is to
discard the session on every embedded open, which is what the SDK does today at the cost of a full
sign-out and PKCE round trip each time.

This capability supplies that signal as an opaque, project-salted hint derived from the signed-in
user's Entra object identifier. It is derived independently by the host and the workload, so the two
derivations must agree byte for byte; the canonical algorithm and its shared test vector are
normative here.

## Requirements

### Requirement: Canonical Fabric user hint derivation

The system SHALL derive an opaque Fabric user hint from the signed-in Fabric user's Entra object identifier using a single canonical algorithm, implemented independently in the workload service and in the browser, producing byte-identical output.

The derivation SHALL be:

```text
hint = BASE64URL_NOPAD( SHA-256( UTF8( DOMAIN "|" projectId "|" oid ) )[0 .. 16] )
```

where `DOMAIN` is the version-bearing constant `rayfin.sh.fu.v1`, `projectId` and `oid` are lowercase canonical hyphenated GUID strings, the separator is U+007C, the digest is truncated to its first 16 bytes, and the encoding is base64url without padding.

Both implementations SHALL be covered by a shared, checked-in test vector.

#### Scenario: Derivation produces the canonical test vector

- **WHEN** the hint is derived with `projectId` of `3f2504e0-4f89-41d3-9a0c-0305e82c3301` and `oid` of `6ba7b810-9dad-11d1-80b4-00c04fd430c8`
- **THEN** the SHA-256 digest of the derivation input SHALL be `4e8550bf7a7628ed44d4ac025a6a311708dc3f41eed7f7eba1a9357fc549aa69`
- **AND** the derived hint SHALL be `ToVQv3p2KO1E1KwCWmoxFw`
- **AND** the derived hint SHALL be 22 characters long

#### Scenario: Both implementations agree on the test vector

- **WHEN** the workload-service implementation and the browser implementation each derive the hint from the same `projectId` and `oid`
- **THEN** both SHALL produce the identical string
- **AND** each implementation SHALL assert the canonical test vector in its own test suite

#### Scenario: Identifier casing and format are normalized

- **WHEN** a `projectId` or `oid` is supplied in uppercase, in braced form, or in unhyphenated form
- **THEN** the implementation SHALL normalize it to the lowercase canonical hyphenated form before hashing
- **AND** the derived hint SHALL equal the hint derived from the already-normalized input

#### Scenario: A different user yields a different hint

- **WHEN** two distinct Entra object identifiers are used with the same `projectId`
- **THEN** the derived hints SHALL differ

#### Scenario: The same user yields a different hint per app

- **WHEN** the same Entra object identifier is used with two distinct `projectId` values
- **THEN** the derived hints SHALL differ

### Requirement: The embedded host transmits the Fabric user hint

When the Fabric extension loads a deployed app in an embedded iframe, it SHALL derive the Fabric user hint for the currently signed-in Fabric user and include it as an opaque query parameter on the iframe URL.

The iframe SHALL NOT be mounted before the hint has been derived, so that no request is issued without it.

#### Scenario: Iframe URL carries the hint

- **WHEN** the extension resolves the iframe URL for a deployed app
- **THEN** the URL SHALL include the embedded-mode marker
- **AND** the URL SHALL include the derived Fabric user hint as a query parameter

#### Scenario: Iframe is not mounted before the hint resolves

- **WHEN** hint derivation has been started but has not completed
- **THEN** the iframe SHALL NOT be rendered with a URL lacking the hint
- **AND** the app SHALL NOT issue a request until the hint is available

#### Scenario: Raw identifier never appears in the URL

- **WHEN** the extension constructs the iframe URL
- **THEN** the URL SHALL NOT contain the Fabric user's Entra object identifier or user principal name in any form other than the derived hint

#### Scenario: Hint unavailable

- **WHEN** the current Fabric user's object identifier cannot be resolved
- **THEN** the extension SHALL omit the hint parameter rather than emit an empty or placeholder value

### Requirement: The serve cookie binds the Fabric user hint

When the workload mints a serve cookie through the Fabric brokered handoff, it SHALL seal the Fabric user hint of the authenticated user into the cookie payload, and SHALL verify that binding on every subsequent request.

#### Scenario: Hint is sealed at mint

- **WHEN** the gate mints a serve cookie after a successful Fabric brokered handoff
- **THEN** the cookie payload SHALL include the Fabric user hint derived from the authenticated user's Entra object identifier and the app's project identifier
- **AND** the hint SHALL be covered by the cookie's signature

#### Scenario: Cookie payload excludes raw identity

- **WHEN** the gate mints a serve cookie
- **THEN** the cookie payload SHALL NOT contain the user's Entra object identifier, user principal name, or email address

#### Scenario: Sealed hint survives a cookie refresh

- **WHEN** an actively used cookie is re-signed to extend its idle lifetime
- **THEN** the re-signed cookie SHALL carry the same Fabric user hint as the cookie it replaces

### Requirement: The gate enforces Fabric user continuity

When a request presents both a serve cookie and a Fabric user hint, the gate SHALL compare the hint against the hint sealed in the cookie, and SHALL reject the cookie when they differ.

A rejection on this basis SHALL be classified as definitive.

#### Scenario: Matching hint authorizes the request

- **WHEN** a request presents a valid serve cookie whose sealed hint equals the request's hint
- **THEN** the gate SHALL authorize the request
- **AND** the gate SHALL NOT require a new authentication handoff

#### Scenario: Differing hint rejects the cookie

- **WHEN** a request presents an otherwise-valid serve cookie whose sealed hint differs from the request's hint
- **THEN** the gate SHALL reject the cookie
- **AND** the rejection SHALL be classified as definitive so the cookie is cleared
- **AND** the request SHALL receive the same no-credential response it would have received with no cookie present

#### Scenario: Cookie without a sealed hint is rejected

- **WHEN** a request presents a Fabric user hint and a valid serve cookie that carries no sealed hint
- **THEN** the gate SHALL reject the cookie as definitively invalid

#### Scenario: Request without a hint is unaffected

- **WHEN** a request presents a valid serve cookie and no Fabric user hint
- **THEN** the gate SHALL NOT reject the cookie on continuity grounds
- **AND** the request SHALL be evaluated by the remaining access rules unchanged

#### Scenario: Continuity is enforced on every request

- **WHEN** a document request and a subsequent asset request both present a hint
- **THEN** the gate SHALL evaluate continuity on each of them independently

### Requirement: The Fabric user hint narrows access only

The Fabric user hint SHALL only ever cause a cookie to be rejected. It SHALL NOT be capable of causing a request to be authorized that would otherwise be denied.

#### Scenario: Forged hint cannot grant access

- **WHEN** a request presents a fabricated or altered Fabric user hint and no valid serve cookie
- **THEN** the gate SHALL deny the request exactly as it would with no hint present
- **AND** the response SHALL NOT include a serve cookie

#### Scenario: Forged hint only forces re-authentication

- **WHEN** a request presents a valid serve cookie and a fabricated hint that does not match the sealed hint
- **THEN** the outcome SHALL be rejection and re-authentication through the existing brokered handoff
- **AND** no session SHALL be served to a caller who could not independently authenticate

### Requirement: Identity gating applies only where the access gate runs

Fabric user continuity SHALL be enforced by the workload's static-hosting access gate. Where that gate does not run — because access control is disabled for the tenant, or the app's effective posture is public — no continuity guarantee SHALL be claimed.

The embedded client SHALL NOT implement a second, independent continuity check.

#### Scenario: Gated app enforces continuity

- **WHEN** an app is served with access control enabled and a non-public effective posture
- **THEN** every request SHALL be subject to the continuity comparison

#### Scenario: Ungated app makes no continuity guarantee

- **WHEN** access control is disabled for the tenant, or the effective posture is public
- **THEN** the gate SHALL serve without evaluating continuity
- **AND** a session persisted for this origin MAY be reused regardless of which Fabric user is signed in to the host

#### Scenario: A host that stamps no hint falls back to the pre-feature protection

- **WHEN** an embedded app is loaded by a host that does not stamp a Fabric user hint
- **THEN** the SDK SHALL discard any persisted session and force a fresh handoff on the first authentication call of that page load
- **AND** no persisted session SHALL be reused before that handoff completes

#### Scenario: The client performs no independent identity comparison

- **WHEN** an embedded app starts up
- **THEN** the SDK SHALL NOT request the host's current user identity
- **AND** the SDK SHALL NOT compare identities itself
- **AND** the SDK's only signal SHALL be whether a hint was stamped, not what it contains
