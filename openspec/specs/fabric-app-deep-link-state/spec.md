# Spec: Fabric App Deep-Link State

## Purpose

Define how a Rayfin app embedded in the Microsoft Fabric portal reads the state it was launched with, writes state back to the portal URL, and observes changes driven by browser navigation, so that a user can share a link that reopens the exact view they were looking at.

A Fabric App runs in a cross-origin iframe and has no addressable URL of its own, so the host owns encoding, versioning, size enforcement, and browser history while the app supplies an opaque JSON object.
Delivered by `@microsoft/rayfin-app-state-fabric` over the `fabric-app-state` channel.

## Requirements

### Requirement: Synchronous launch state before first render

The system SHALL make the state an app was launched with available synchronously, before the app's first render, so that no default state is visible to the user first.
The host SHALL seed the encoded state onto the iframe URL exactly once at mount.
The SDK SHALL expose `getLaunchStateSync()` returning the decoded state, or `undefined` when the app was launched without state.
The SDK SHALL remove the parameter from the app's own URL after reading it, without affecting the portal URL.

#### Scenario: App launched from a shared link restores immediately

- **WHEN** a user opens a link whose portal URL carries encoded state
- **THEN** `getLaunchStateSync()` returns the decoded state before the first render, and no default state is painted

#### Scenario: App launched without state

- **WHEN** a user opens the app from a URL with no state parameter
- **THEN** `getLaunchStateSync()` returns `undefined` and the app restores its own defaults

#### Scenario: Malformed state degrades safely

- **WHEN** the state parameter is absent, truncated, not valid base64url, not valid JSON, of an unknown version, or not a plain object
- **THEN** the launch state resolves to `undefined` and the app starts normally rather than failing

#### Scenario: Launch parameter is scrubbed from the app URL

- **WHEN** the client reads seeded launch state from the live URL
- **THEN** the parameter is removed from the app's address bar so it is not resent to the app's server or leaked in referrers

### Requirement: Writing state to the portal URL

The system SHALL allow an embedded app to write an opaque JSON object into the Fabric portal URL.
`setState()` SHALL add a browser history entry, and `replaceState()` SHALL update the URL without adding one.
The host SHALL own encoding and SHALL be authoritative for size limits.
Writes SHALL NOT cause the iframe to reload.

#### Scenario: setState updates the portal URL and history

- **WHEN** an app calls `setState()` with a valid state object
- **THEN** the portal URL reflects the encoded state and a new browser history entry is created

#### Scenario: replaceState updates the URL without a history entry

- **WHEN** an app calls `replaceState()` with a valid state object
- **THEN** the portal URL reflects the encoded state and no new history entry is created

#### Scenario: Writes never reload the embedded app

- **WHEN** an app performs any number of state writes
- **THEN** the iframe is not navigated or reloaded, and app state in memory is preserved

#### Scenario: Write order is preserved

- **WHEN** an app issues several `setState()` calls in sequence without awaiting each one
- **THEN** the resulting history entries appear in the order the calls were made

#### Scenario: Rapid replaces collapse

- **WHEN** an app issues several `replaceState()` calls faster than they can be delivered
- **THEN** only the most recent value is written, so the URL does not lag behind the interaction

### Requirement: State validation

The system SHALL reject state that cannot survive a JSON round trip, rather than silently degrading it.
The SDK SHALL validate before contacting the host and SHALL raise `FabricAppStateError` with a stable `code`.
Error messages SHALL NOT contain state values.

#### Scenario: Non-serialisable values are rejected

- **WHEN** state contains `undefined`, a function, a symbol, a bigint, `NaN`, `Infinity`, a `Date`, a `Map`, a `Set`, or a class instance
- **THEN** the call rejects with code `INVALID_STATE` and no message is sent to the host

#### Scenario: Circular references are rejected

- **WHEN** state contains a circular reference
- **THEN** the call rejects with code `INVALID_STATE`

#### Scenario: The same object may appear as two siblings

- **WHEN** state contains the same object under two different keys without a cycle
- **THEN** the state is accepted, because it serialises correctly

#### Scenario: Oversized state is rejected with actionable guidance

- **WHEN** state exceeds the encoded size budget
- **THEN** the call rejects with code `STATE_TOO_LARGE` and the message advises storing large state server-side with an identifier in the URL

#### Scenario: Over-deep state is rejected

- **WHEN** state nests deeper than the depth limit
- **THEN** the call rejects with code `STATE_TOO_DEEP`

#### Scenario: Errors are safe to log

- **WHEN** any validation error is raised
- **THEN** the message identifies the offending property path but does not include the offending value

### Requirement: Change notification for browser navigation

The system SHALL notify the app when the state changes for a reason other than the app's own write, so that Back and Forward navigate within the app instead of navigating the portal away from it.
The host SHALL NOT echo the app's own writes back to it.
Events SHALL carry an `epoch` and a monotonic `revision`, and the SDK SHALL discard any event whose revision is not greater than the last applied revision within the same epoch.

#### Scenario: Back and Forward restore earlier state

- **WHEN** a user presses Back or Forward across entries created by `setState()`
- **THEN** the registered listener is invoked with the state for that entry

#### Scenario: Returning to a stateless URL

- **WHEN** navigation reaches a URL that carries no state
- **THEN** the listener is invoked with `undefined` so the app restores its defaults

#### Scenario: The app's own write is not echoed

- **WHEN** an app writes state and the portal URL updates as a result
- **THEN** no change notification is delivered for that write, so an app that writes inside its own handler does not loop

#### Scenario: Out-of-order and duplicate events are discarded

- **WHEN** events arrive out of order or more than once within one epoch
- **THEN** only strictly increasing revisions are applied

#### Scenario: A counter reset does not silence the app

- **WHEN** the host resets its revision counter and increments the epoch
- **THEN** subsequent events are applied even though their revision is lower than the previously applied one

#### Scenario: Events from an unexpected source are ignored

- **WHEN** a message arrives from a different window, a different origin than configured, a different channel, a different kind, or a different protocol version
- **THEN** it is ignored

### Requirement: Capability detection and graceful degradation

The system SHALL let an app determine whether the host supports deep linking, so that share affordances are not shown where they cannot work.
`isSupported()` SHALL resolve to the host's capabilities, or `undefined` when the feature is unavailable.
The host SHALL be authoritative for limits.

#### Scenario: Unsupported host reports unavailable

- **WHEN** the app runs on a host that does not implement the app-state channel
- **THEN** `isSupported()` resolves to `undefined` and `getLaunchState()` resolves to `undefined` rather than throwing, so the app still starts

#### Scenario: A host that is still mounting is not mistaken for an unsupported one

- **WHEN** the app requests capabilities before the host has registered its bridge
- **THEN** the request is retried a bounded number of times before the feature is reported unavailable

#### Scenario: Replace-only host is reported

- **WHEN** the host can update the URL but cannot add history entries
- **THEN** `isSupported()` reports `canPush: false`, and `setState()` still updates the URL so links remain shareable

#### Scenario: Writes on an unsupported host are surfaced

- **WHEN** an app calls `setState()` on a host without app-state support
- **THEN** the call rejects with code `UNSUPPORTED_HOST_CAPABILITY`

### Requirement: State confidentiality and integrity expectations

The system SHALL treat app state as user-visible and untrusted.
Documentation SHALL require Builders to validate launch state before use and SHALL prohibit placing secrets, tokens, or personal data in state.
Host telemetry SHALL NOT record state contents.

#### Scenario: Telemetry excludes state contents

- **WHEN** the host records telemetry for an app-state operation
- **THEN** it records only operation kind, outcome category, encoded size bucket, and protocol version, never parameter contents, decoded values, or full URLs

#### Scenario: State is scoped to its own app item

- **WHEN** a user opens a link for one app item
- **THEN** that state is not delivered to a different app item

### Requirement: Ringed rollout

Portal support SHALL be gated by the `BaaS_EmbeddedAppDeepLinking` feature switch, defaulting to off, so it can be rolled out and rolled back per ring without redeploying the SDK.

#### Scenario: Feature disabled

- **WHEN** the feature switch is off
- **THEN** the app-state channel is not registered, apps report the feature as unsupported, and the portal behaves exactly as before
