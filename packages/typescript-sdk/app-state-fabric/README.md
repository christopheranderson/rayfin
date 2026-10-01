# @microsoft/rayfin-app-state-fabric

Deep-link application state for Rayfin apps embedded in the Fabric portal.

## Getting started

```bash
npm install @microsoft/rayfin-app-state-fabric
```

For more details, [visit our docs](https://aka.ms/rayfin/docs).

## Deep linking

A Fabric App runs in an iframe and cannot touch the portal address bar directly.
`createFabricAppStateClient()` lets your app read the state it was launched with and write state back, so a user can share a link that reopens the exact view they were looking at.

Read launch state *before* your first render so default state never flashes:

```ts
import { createFabricAppStateClient } from '@microsoft/rayfin-app-state-fabric';

const appState = createFabricAppStateClient();

const launch = appState.getLaunchStateSync();
renderApp(launch ?? defaultView);
```

> **Leave `targetOrigin` unset.**
> The embedding Fabric extension host does not share the portal origin in the address bar, and it varies per environment.
> A wrong pin makes the browser drop every message silently. When omitted, messages are posted with `"*"` and inbound events are not origin-checked.

Write state as the user navigates.
Use `setState` for navigation the user would expect the Back button to undo, and `replaceState` for transient changes such as dragging a slider:

```ts
await appState.setState({ view: 'sales-by-region', filter: 'AT' });
await appState.replaceState({ view: 'sales-by-region', filter: 'AT', zoom: 3 });
```

React to the Back and Forward buttons.
The listener receives `undefined` when the user reaches a URL that carries no state, which means you should restore your defaults:

```ts
const unsubscribe = appState.onStateChange((state) => {
  restore(state ?? defaultView);
});

// On teardown
unsubscribe();
appState.dispose();
```

Deep linking rolls out per tenant, so check support before showing a share button:

```ts
const capabilities = await appState.isSupported();
if (capabilities) {
  showShareButton();
  // Some hosts can update the URL but not add history entries.
  if (!capabilities.canPush) hideBackForwardHints();
}
```

### Running outside the portal

The same app often ships standalone as well as embedded, where it owns its own address bar and there is no host to talk to.
The client is safe to construct either way: nothing throws at construction, and it never rewrites a URL it does not own.

`isSupported()` is the single branch point.
It resolves to `undefined` when the app is not embedded, so the check that guards a share button also selects your standalone path:

```ts
const capabilities = await appState.isSupported();

if (capabilities) {
  // Embedded in Fabric: the portal owns the address bar.
  await appState.setState({ view: 'sales', region: 'AT' });
} else {
  // Standalone: the app owns its own URL, so use your router.
  router.push({ path: '/sales', query: { region: 'AT' } });
}
```

What each call does when the app is not embedded:

| Call | Standalone result |
| --- | --- |
| `isSupported()` | `undefined` |
| `getLaunchStateSync()` | seeded state when the URL carries it, otherwise `undefined` |
| `getLaunchState()` | the same, and never rejects |
| `setState()` / `replaceState()` | rejects with `NO_HOST_WINDOW` |
| `onStateChange()` | the listener registers but never fires |

Writes reject rather than silently doing nothing, so a missing branch shows up in development instead of quietly dropping state.
Branch on `isSupported()`, or catch `NO_HOST_WINDOW` if you would rather attempt the write.

### Rules and limits

- State must be a plain JSON object.
  `Date`, `Map`, `Set`, class instances, functions, and `undefined` are rejected rather than silently degraded.
- State is capped at 4 KiB encoded and 20 levels deep so links survive proxies, mail gateways, and chat clients.
  For anything larger, store it yourself and put an identifier in the state.
- The whole object is replaced on every write.
  There is no partial or namespaced update, so an app with several independent pieces of state must merge them itself before writing.
- Your app owns the shape of its state.
  The encoding is versioned, but the payload is not, so a link shared before a shape change will still arrive in the old shape and your app must tolerate it.
- Errors are `FabricAppStateError` with a stable `code`.
  Branch on the code, not the message.

### Security

State travels in a URL, so treat it accordingly.

- **It is visible to the user.** It appears in the address bar, browser history, and bookmarks.
  Never put secrets, tokens, or personal data in it.
- **It is untrusted input.** Anyone can edit a link before sending it, so validate launch state exactly as you would a query parameter before using it to drive queries.
  Your app should also tolerate state written by a different version of itself.

## Security

Microsoft takes the security of our software products and services seriously, which
includes all source code repositories in our GitHub organizations.

**Please do not report security vulnerabilities through public GitHub issues.**

For security reporting information, locations, contact information, and policies,
please review the latest guidance for Microsoft repositories at
[https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos must follow the [Microsoft Trademark and Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos is subject to those third parties' policies.

## License

Copyright (c) Microsoft Corporation.

MIT License
