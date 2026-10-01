# Spec: postMessage Handoff Protocol

## Purpose

Define the `postMessage`-based communication protocol between the Fabric Portal extension (sender) and the Rayfin SPA (receiver) for delivering brokered authentication handoff codes.

## Requirements

### Requirement: postMessage message contract

The Fabric extension and SPA SHALL communicate using structured `postMessage` payloads with a `type` discriminator prefixed with `brokeredAuth.`.

#### Scenario: Handoff success message shape

- **WHEN** the Fabric extension successfully acquires a handoff code
- **THEN** it MUST send a message via `window.top.opener.postMessage(data, returnOrigin)` where `data` is `{ type: 'brokeredAuth.handoff', handoffCode: string, state: string }`
- **AND** `type` MUST be the literal string `'brokeredAuth.handoff'`

#### Scenario: Error message shape

- **WHEN** the Fabric extension fails to acquire a handoff code
- **THEN** it MUST send a message via `window.top.opener.postMessage(data, returnOrigin)` where `data` is `{ type: 'brokeredAuth.error', error: string, errorDescription: string, state: string }`
- **AND** `type` MUST be the literal string `'brokeredAuth.error'`
- **AND** `error` MUST be a machine-readable code (e.g., `'MWC_TOKEN_FAILED'`, `'AUTHORIZE_FAILED'`)
- **AND** `errorDescription` MUST be a human-readable message

#### Scenario: State is always included

- **WHEN** the extension sends any message (success or error)
- **THEN** the `state` field MUST be included with the value from the broker URL query parameter
- **AND** `state` MUST be present even if the error occurred before the authorize call (using the value from the URL)

### Requirement: postMessage origin security

Both the sender (Fabric extension) and receiver (SPA) SHALL validate message origins to prevent credential interception.

#### Scenario: Extension uses explicit targetOrigin

- **WHEN** the Fabric extension sends a message via `postMessage`
- **THEN** the second argument MUST be the `returnOrigin` value from the broker URL query parameters
- **AND** `"*"` MUST NOT be used as the targetOrigin

#### Scenario: SPA validates event.origin

- **WHEN** the SPA receives a `message` event
- **THEN** it MUST compare `event.origin` against the origin derived from `options.fabricPortalUrl` (i.e., `new URL(options.fabricPortalUrl).origin`)
- **AND** messages from non-matching origins MUST be silently ignored (not rejected, not logged as errors)

#### Scenario: Non-object messages ignored

- **WHEN** the SPA receives a `message` event where `event.data` is not an object
- **THEN** the message MUST be silently ignored

#### Scenario: Messages without matching state ignored

- **WHEN** the SPA receives a valid-origin message with `event.data.state` that does not match the expected state nonce
- **THEN** the message MUST be silently ignored (another auth flow may be in progress)

### Requirement: SPA postMessage listener lifecycle

`initiateFabricLogin` SHALL register a `message` event listener before opening the Fabric tab and remove it on any terminal event.

#### Scenario: Listener registered before window.open

- **WHEN** `initiateFabricLogin(auth, options)` is called
- **THEN** `window.addEventListener('message', handler)` MUST be called before `window.open(brokerUrl, '_blank')`

#### Scenario: Listener removed on successful handoff

- **WHEN** a `brokeredAuth.handoff` message is received with matching state and valid origin
- **THEN** the `message` event listener MUST be removed via `window.removeEventListener('message', handler)`
- **AND** the timeout timer MUST be cleared

#### Scenario: Listener removed on error

- **WHEN** a `brokeredAuth.error` message is received with matching state and valid origin
- **THEN** the `message` event listener MUST be removed
- **AND** the timeout timer MUST be cleared

#### Scenario: Listener removed on timeout

- **WHEN** no matching message is received within 5 minutes
- **THEN** the `message` event listener MUST be removed
- **AND** the promise MUST reject with `AuthError` code `FABRIC_AUTH_TIMEOUT`

### Requirement: Fabric tab management

The SDK SHALL close the Fabric Portal tab after receiving the handoff code.

#### Scenario: Close tab on success

- **WHEN** a `brokeredAuth.handoff` message is received and the handoff code is successfully exchanged for tokens
- **THEN** the Fabric tab (the `Window` reference from `window.open()`) MUST be closed via `fabricWindow.close()`

#### Scenario: Close tab on error

- **WHEN** a `brokeredAuth.error` message is received
- **THEN** the Fabric tab MUST be closed via `fabricWindow.close()`

#### Scenario: Tab reference is null

- **WHEN** `window.open()` returns `null` (tab blocked)
- **THEN** the promise MUST reject with `AuthError` code `TAB_BLOCKED`
- **AND** the message listener MUST be removed

### Requirement: In-closure token exchange

When the SPA receives the handoff code via `postMessage`, `initiateFabricLogin` SHALL exchange it for tokens using the `code_verifier` held in its closure.

#### Scenario: Successful token exchange

- **WHEN** a `brokeredAuth.handoff` message is received with matching state and valid origin
- **THEN** `auth.getAuthApi().exchangeVerificationCode()` MUST be called with the `handoffCode` from the message, the `code_verifier` from the closure, and `codeType: 'fabric_handoff'`
- **AND** `auth.createSessionFromTokenResponse()` MUST be called with the token response
- **AND** the promise MUST resolve

#### Scenario: Token exchange failure

- **WHEN** `exchangeVerificationCode()` throws an error
- **THEN** the promise MUST reject with the error
- **AND** the message listener MUST be removed
- **AND** the Fabric tab MUST be closed

### Requirement: Extension opener chain

The Fabric extension (running in a sandboxed iframe) SHALL access the SPA window via `window.top.opener`.

#### Scenario: Opener available

- **WHEN** the extension loads in the Fabric Portal and the Portal tab was opened via `window.open()` from the SPA
- **THEN** `window.top` MUST resolve to the Portal's top-level browsing context
- **AND** `window.top.opener` MUST resolve to the SPA window
- **AND** `postMessage()` MUST be callable on `window.top.opener`

#### Scenario: Opener not available

- **WHEN** `window.top.opener` is `null` or `undefined` (user navigated directly to the broker URL)
- **THEN** the extension MUST NOT attempt `postMessage`
- **AND** the extension MUST display an error indicating the page must be opened from a Rayfin application
