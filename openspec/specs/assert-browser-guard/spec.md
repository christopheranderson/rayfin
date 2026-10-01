# assert-browser-guard Specification

## Purpose

Define a shared `assertBrowser()` guard utility in `@microsoft/rayfin-lib` and require every browser-only public entry point in the Fabric auth provider and Fabric embedded host packages to call it, so they fail fast with a clear `BROWSER_ONLY` error when invoked outside a browser.

## Requirements

### Requirement: assertBrowser utility in rayfin-lib

The `@microsoft/rayfin-lib` package SHALL export a shared `assertBrowser()` utility function for browser-only packages.

#### Scenario: assertBrowser throws in Node.js

- **WHEN** `assertBrowser('initiateFabricLogin')` is called in a Node.js environment
- **THEN** the function MUST throw an `SdkError`
- **AND** the error message MUST include the API name (e.g., `initiateFabricLogin() requires a browser environment`)
- **AND** the error message MUST suggest using `RayfinServerClient` for Node.js
- **AND** the error code MUST be `BROWSER_ONLY`

#### Scenario: assertBrowser is no-op in browser

- **WHEN** `assertBrowser('initiateFabricLogin')` is called in a browser environment
- **THEN** the function MUST NOT throw
- **AND** execution MUST continue normally

### Requirement: Browser guard on auth-provider-fabric entry points

Every public entry point in `@microsoft/rayfin-auth-provider-fabric` SHALL call `assertBrowser()` as its first statement.

#### Scenario: initiateFabricLogin guarded

- **WHEN** `initiateFabricLogin()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs

#### Scenario: embeddedFabricLogin guarded

- **WHEN** `embeddedFabricLogin()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs

#### Scenario: bridgeFabricCallback guarded

- **WHEN** `bridgeFabricCallback()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs

#### Scenario: ensureSignedInWithFabric guarded

- **WHEN** `ensureSignedInWithFabric()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs

### Requirement: Browser guard on fabric-embedded-host entry points

Every public entry point in `@microsoft/rayfin-fabric-embedded-host` SHALL call `assertBrowser()` as its first statement.

#### Scenario: isEmbeddedMode guarded

- **WHEN** `isEmbeddedMode()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs

#### Scenario: clearEmbeddedMode guarded

- **WHEN** `clearEmbeddedMode()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs

#### Scenario: sendBridgeRequest guarded

- **WHEN** `sendBridgeRequest()` is called outside a browser
- **THEN** it MUST throw `SdkError` with code `BROWSER_ONLY` before accessing any browser APIs
