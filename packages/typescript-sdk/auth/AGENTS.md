# @microsoft/rayfin-auth Agent Instructions

Authentication SDK for Rayfin applications.
See [README.md](./README.md) for API concepts and usage examples.

## Commands

Run these from `packages/typescript-sdk/auth/`:

```bash
# Build
rushx build              # Compile TypeScript
rushx build:watch        # Watch mode

# Test
rushx test              # Run unit tests
rushx test:watch        # Watch mode

# Clean
rushx clean             # Remove build artifacts
```

From repository root:

```bash
rush build --to @microsoft/rayfin-auth    # Build with dependencies
rush test --only @microsoft/rayfin-auth   # Test this package only
rush rebuild --to @microsoft/rayfin-auth  # Clean rebuild
```

## Architecture

- **Main Auth Class** (`src/Auth.ts`): Session management, event system, storage abstraction.
- **HTTP Wrapper** (`src/AuthApi.ts`): Low-level REST API for auth endpoints.
- **Storage Abstraction**: Supports `localStorage`, `sessionStorage`, memory-only, or custom `AuthStorage`.
- **Token Concealment**: Access tokens never exposed in public `OpaqueSession` API.
- **Event System**: `onSessionChange` for React integration; `on(event, handler)` for granular events.

Depends on `@microsoft/rayfin-lib` for HTTP client and error handling.

## Implementation Rules

1. **Session Storage**: Serialization handled in `getInternalSessionFromStorage()` and `setInternalSessionToStorage()`. Expired sessions cleared on load.

2. **Token Extraction**: User ID extracted from JWT via `extractUserIdFromToken()` to handle legacy sessions.

3. **Access Token Provider**: Use `authApi.setAccessTokenProvider(() => this.accessToken)` for loose coupling between Auth and AuthApi.

4. **Storage Key Prefix**: Use `storageKeyPrefix` option to isolate sessions in multi-tenant scenarios. Without prefix, sessions share `authSession` key.

5. **Token Concealment**: Never expose `accessToken` or `refreshToken` in public APIs. Use `attachToClient()` for authenticated requests.

## Testing Strategy

- **Unit Tests**: Use memory-only storage (`storage: false`) with mocked `ApiClient` instances.
- **Integration Tests**: Full auth flows validated in samples (for example, `todo-app`).

## Key Files

- `src/Auth.ts`: Main Auth class
- `src/AuthApi.ts`: HTTP API wrapper
- `src/types.ts`: Type definitions
- `src/roles.ts`: Role constants
- `src/index.ts`: Public exports
