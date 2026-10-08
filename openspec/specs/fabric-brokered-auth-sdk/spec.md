# Spec: Fabric Brokered Auth SDK

## Purpose

Define the `@microsoft/rayfin-auth-provider-fabric` companion package that implements Fabric brokered authentication for Rayfin, including PKCE-secured browser flows, postMessage-based handoff from the Fabric extension, and a high-level `ensureSignedInWithFabric()` waterfall.

> **RFC**: [docs/rfc/fabric-brokered-auth-sdk-changes.md](/docs/rfc/fabric-brokered-auth-sdk-changes.md) — see Change 2 for detailed implementation.
>
## Requirements

### Requirement: Fabric Brokered Auth SDK Types

The `@microsoft/rayfin-auth-provider-fabric` package SHALL export typed interfaces for the Fabric brokered authentication flow.

#### Scenario: FabricAuthOptions contains required fields

- **WHEN** a developer imports `FabricAuthOptions` from `@microsoft/rayfin-auth-provider-fabric`
- **THEN** the type MUST require `workspaceId: string`, `projectId: string`, `fabricPortalUrl: string`, and `returnOrigin: string`
- **AND** `callbackUrl` MUST NOT be present
- **AND** `returnOrigin` MUST be a bare origin string (e.g., `https://myapp.com`), not a full URL with path

#### Scenario: Public entry points throw in non-browser environments

- **WHEN** any public function (`initiateFabricLogin`, `embeddedFabricLogin`, `bridgeFabricCallback`, `ensureSignedInWithFabric`) is called outside a browser environment
- **THEN** the function MUST throw `SdkError` with code `BROWSER_ONLY` as its first operation
- **AND** the error message MUST include the function name and suggest using `RayfinServerClient`
- **AND** no browser APIs (`window.open`, `postMessage`, `BroadcastChannel`) MUST be accessed before the guard

### Requirement: Broker URL Construction

The SDK SHALL construct a Fabric Portal broker URL that preserves the portal URL's existing path and query parameters and appends the artifact deep-link path with the `/brokeredauth` segment and PKCE parameters.

#### Scenario: Broker URL with no existing path

- **WHEN** `buildBrokerUrl()` is called with `fabricPortalUrl` of `https://app.fabric.microsoft.com`
- **THEN** the URL path MUST be `/groups/{workspaceId}/appbackends/{projectId}/brokeredauth`
- **AND** `returnOrigin`, `code_challenge`, `code_challenge_method`, and `state` MUST be query parameters

#### Scenario: Broker URL with existing path

- **WHEN** `buildBrokerUrl()` is called with `fabricPortalUrl` of `https://app.fabric.microsoft.com/some/portal/path`
- **THEN** the URL path MUST be `/some/portal/path/groups/{workspaceId}/appbackends/{projectId}/brokeredauth`
- **AND** the existing path MUST NOT be discarded

#### Scenario: Broker URL preserves existing query parameters

- **WHEN** `buildBrokerUrl()` is called with `fabricPortalUrl` of `https://host.example.com?debug=1&experience=power-bi`
- **THEN** the output URL MUST contain `debug=1` and `experience=power-bi` alongside the PKCE parameters
- **AND** `code_challenge_method` MUST be `S256`

#### Scenario: returnOrigin query parameter value

- **WHEN** `buildBrokerUrl()` constructs the URL
- **THEN** the `returnOrigin` query parameter MUST be set to `options.returnOrigin`
- **AND** it MUST be a bare origin (e.g., `https://myapp.com`), not a path URL

#### Scenario: Query params preserved for backward compatibility

- **WHEN** `buildBrokerUrl()` constructs the URL
- **THEN** `returnOrigin`, `callbackUrl`, `code_challenge`, `code_challenge_method`, and `state` MUST be present as query parameters
- **AND** these query parameters MUST remain even though the new AppBackend route ignores them
- **AND** they MUST enable the Old AppBackend (prefix-match to landing page) to detect broker mode via `parseBrokerParams`

### Requirement: Initiate Fabric Login

The SDK SHALL open the Fabric Portal in a new tab and return a Promise that resolves when the Fabric extension posts the handoff code via `postMessage`.

#### Scenario: Function signature

- **WHEN** `initiateFabricLogin` is called
- **THEN** the signature MUST be `initiateFabricLogin(auth: Auth, options: FabricAuthOptions): Promise<void>`
- **AND** the function MUST use `auth` to call `exchangeVerificationCode` and `createSessionFromTokenResponse`

#### Scenario: Successful initiation

- **WHEN** `initiateFabricLogin(auth, options)` is called with valid options
- **THEN** PKCE parameters (code_verifier, code_challenge, state) MUST be generated
- **AND** the `code_verifier` MUST be held in a closure variable (not persisted to localStorage)
- **AND** a `message` event listener MUST be registered on `window`
- **AND** `window.open()` MUST be called with the broker URL and `'_blank'` target

#### Scenario: Missing required options throws

- **WHEN** `initiateFabricLogin()` is called with a missing `workspaceId`, `projectId`, `returnOrigin`, or `fabricPortalUrl`
- **THEN** the function MUST throw an `AuthError` with the corresponding `MISSING_*` error code

#### Scenario: Tab blocked by browser

- **WHEN** `window.open()` returns `null`
- **THEN** the promise MUST reject with an `AuthError` with code `TAB_BLOCKED`
- **AND** the message listener MUST be removed

#### Scenario: Authentication times out

- **WHEN** no matching `postMessage` is received within 5 minutes
- **THEN** the promise MUST reject with an `AuthError` with code `FABRIC_AUTH_TIMEOUT`
- **AND** the message listener MUST be removed

### Requirement: Ensure Signed In With Fabric (Waterfall)

The SDK SHALL provide a high-level `ensureSignedInWithFabric()` function that implements a 4-step waterfall.

In embedded mode, whether steps 1 and 2 run SHALL depend on whether the host stamped a Fabric user hint on the app URL. A hint means the workload's static-hosting gate has already compared the session's identity against the current Fabric user before the app booted, so a persisted session may be resumed. No hint means no such comparison occurred, and the SDK SHALL fall back to discarding the persisted session and forcing a handoff on the first call per page load.

#### Scenario: Step 1 — already authenticated

- **WHEN** `auth.getSession().isAuthenticated` is true
- **AND** the waterfall is not on the legacy embedded path
- **THEN** the function MUST return the existing session immediately without any network calls

#### Scenario: Step 2 — refresh token available

- **WHEN** the user is not authenticated but `auth.hasRefreshToken()` is true
- **AND** the waterfall is not on the legacy embedded path
- **THEN** the function MUST attempt `auth.refreshSession()`
- **AND** if the refresh succeeds, the function MUST return the refreshed session

#### Scenario: Step 3 — embedded handoff

- **WHEN** no prior step succeeded and the SDK is in embedded mode
- **THEN** the function MUST call `embeddedFabricLogin(auth, options)`
- **AND** if the resulting session is authenticated, the function MUST return it
- **AND** if `embeddedFabricLogin` rejects with `NO_PARENT_WINDOW`, the function MUST fall through to Step 4

#### Scenario: Step 4 — open Fabric broker

- **WHEN** no prior step succeeded
- **THEN** the function MUST call `initiateFabricLogin(auth, options)` to open a new tab
- **AND** after the promise resolves, the function MUST return the session from `auth.getSession()`

#### Scenario: A stamped hint allows session reuse

- **WHEN** the SDK is in embedded mode on a first page load with a persisted authenticated session
- **AND** the host stamped a Fabric user hint
- **THEN** Step 1 MUST return the existing session
- **AND** the function MUST NOT initiate an authentication handoff

#### Scenario: An absent hint forces a handoff

- **WHEN** the SDK is in embedded mode on a first page load with a persisted authenticated session
- **AND** the host stamped no Fabric user hint
- **THEN** Steps 1 and 2 MUST be skipped
- **AND** the function MUST proceed to Step 3

#### Scenario: Later calls on a legacy host reuse the established session

- **WHEN** the SDK is in embedded mode with no stamped hint
- **AND** an embedded handoff has already completed during this page load
- **THEN** Step 1 MUST return the session established by that handoff
- **AND** the function MUST NOT initiate a further handoff

#### Scenario: The hint survives a client-side navigation

- **WHEN** the app performs a client-side navigation that strips the query string
- **THEN** a hint observed earlier in the page load MUST still be treated as present
- **AND** the SDK MUST NOT fall back to the legacy path on that basis

#### Scenario: The fallback is embedded-only

- **WHEN** the SDK is not in embedded mode
- **THEN** the absence of a hint MUST NOT cause Steps 1 and 2 to be skipped

#### Scenario: Session not established

- **WHEN** `initiateFabricLogin()` resolves but `auth.getSession().isAuthenticated` is false
- **THEN** the function MUST throw an `AuthError` with code `SESSION_NOT_ESTABLISHED`

### Requirement: Package Public API Surface

The `@microsoft/rayfin-auth-provider-fabric` package SHALL export the following public API.

#### Scenario: Function exports

- **WHEN** a consumer imports from `@microsoft/rayfin-auth-provider-fabric`
- **THEN** `ensureSignedInWithFabric` and `initiateFabricLogin` MUST be available as named exports
- **AND** `handleFabricCallback` and `isFabricCallback` MUST NOT be exported

#### Scenario: Type exports

- **WHEN** a consumer imports types from `@microsoft/rayfin-auth-provider-fabric`
- **THEN** `FabricAuthOptions` MUST be available as a named type export
- **AND** `FabricCallbackOptions` and `FabricCallbackResult` MUST NOT be exported

### Requirement: Embedded login signs out only on the legacy path

`embeddedFabricLogin()` SHALL sign out before requesting a handoff only when the host stamped no Fabric user hint.

#### Scenario: No sign-out when the host stamps a hint

- **WHEN** `embeddedFabricLogin(auth, options)` is called and a Fabric user hint is present
- **THEN** the function MUST NOT call `auth.signOut()`
- **AND** the function MUST proceed directly to the handoff request

#### Scenario: Sign-out when the host stamps no hint

- **WHEN** `embeddedFabricLogin(auth, options)` is called and no Fabric user hint is present
- **THEN** `auth.signOut()` MUST be called before the handoff is requested

#### Scenario: A failing legacy sign-out does not abort the handoff

- **WHEN** the legacy pre-handoff `auth.signOut()` rejects
- **THEN** the function MUST continue to the handoff request
- **AND** the session MUST still be established from the handoff result

#### Scenario: The bound serve session is not needlessly invalidated

- **WHEN** an embedded page load presents a valid serve cookie and the host stamped a hint
- **THEN** the SDK MUST NOT perform any action that invalidates the Rayfin session the serve cookie is bound to
