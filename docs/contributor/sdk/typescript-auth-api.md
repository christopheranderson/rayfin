# TypeScript Auth API

This document describes the TypeScript Auth API provided in the `@microsoft/rayfin-auth` package.

## Overview

The `@microsoft/rayfin-auth` package provides a client-side authentication API for Rayfin applications. It handles user registration, authentication, session management, and token handling.

## Installation

```bash
npm install @microsoft/rayfin-auth
```

## Key Components

### `Auth` Class

The main class that provides authentication functionality.
The constructor is isomorphic — it detects the runtime environment automatically and skips browser-only APIs (localStorage, StorageEvent) when `window` is undefined.

```typescript
import { Auth } from '@microsoft/rayfin-auth';
import { ApiClient } from '@microsoft/rayfin-lib';

const apiClient = new ApiClient({ baseUrl: 'https://api.example.com' });

// Browser — defaults to localStorage
const auth = new Auth(apiClient);

// Node.js / React Native — custom storage + opt-out flags
const auth = new Auth(apiClient, {
  storage: asyncStorageAdapter,
  autoRefreshToken: false,   // manual via startAutoRefresh/stopAutoRefresh
  multiTabSync: false,       // no StorageEvent in non-browser runtimes
});
```

The `Auth` class uses lazy initialization — the constructor does not perform any async I/O.
The first public method call (e.g., `getSession()`, `signIn()`) triggers `ensureInitialized()` which restores any persisted session and cleans up stale PKCE states.

### Authentication Flow

#### User Registration (Sign Up)

```typescript
const credentials = {
  email: 'user@example.com',
  password: 'securePassword123',
};

try {
  const response = await auth.signUp(credentials);
  console.log('Signed up successfully', response);
  // response contains: userId, email, token, role, createdAt
} catch (error) {
  console.error('Sign up failed', error);
}
```

#### User Login (Sign In)

```typescript
const credentials = {
  email: 'user@example.com',
  password: 'securePassword123',
};

try {
  const response = await auth.signIn(credentials);
  console.log('Signed in successfully', response);
  // response contains: userId, email, token, role, expiresAt
} catch (error) {
  console.error('Sign in failed', error);
}
```

#### Anonymous Access

```typescript
try {
  const response = await auth.getAnonymousToken();
  console.log('Got anonymous token', response);
  // response contains: token, role
} catch (error) {
  console.error('Failed to get anonymous token', error);
}
```

#### Sign Out

```typescript
try {
  await auth.signOut();
  console.log('Signed out successfully');
} catch (error) {
  console.error('Sign out failed', error);
}
```

### Session Management

#### Get Current Session

`getSession()` returns the current `OpaqueSession` synchronously from the
in-memory cache. With synchronous storage (browser `localStorage`) the session
is restored in the constructor; with asynchronous storage it is restored shortly
after construction, so subscribe via `onSessionChange()` to be notified once it
lands.

```typescript
const session = auth.getSession();
if (session.isAuthenticated) {
  console.log('User is logged in', session.user);
} else {
  console.log('No active session');
}
```

#### Listen for Auth State Changes

```typescript
const unsubscribe = auth.onAuthStateChange((session) => {
  if (session) {
    console.log('User logged in:', session.user);
  } else {
    console.log('User logged out');
  }
});

// Later, to stop listening:
unsubscribe();
```

## API Reference

### Auth Class

#### Constructor

```typescript
constructor(apiClient: ApiClient, options?: AuthOptions)
```

- `apiClient`: An instance of ApiClient from `@microsoft/rayfin-lib` package
- `options`: Optional configuration object:
  - `storage` — `AuthStorage | boolean` — storage adapter, `false` for memory-only, `true`/omit for auto-detect
  - `storageKeyPrefix` — `string` — prefix for storage keys (multi-tenant isolation)
  - `persistSession` — `boolean` (default `true`) — whether to persist session to storage
  - `autoRefreshToken` — `boolean` (default `true`) — automatically refresh tokens before expiry
  - `multiTabSync` — `boolean` (default auto-detect) — sync session across browser tabs via StorageEvent

#### Methods

##### signUp

```typescript
async signUp(credentials: SignUpCredentials): Promise<SignUpResponse>
```

Registers a new user with email and password.

- `credentials`: Object containing email and password
- Returns: Promise resolving to sign-up response with user details and token

##### signIn

```typescript
async signIn(credentials: SignInCredentials): Promise<SignInResponse>
```

Authenticates a user with email and password.

- `credentials`: Object containing email and password
- Returns: Promise resolving to sign-in response with user details and token

##### getAnonymousToken

```typescript
async getAnonymousToken(): Promise<AnonymousTokenResponse>
```

Gets an anonymous token for limited API access without authentication.

- Returns: Promise resolving to response containing anonymous token

##### signOut

```typescript
async signOut(): Promise<void>
```

Signs out the current user.

- Returns: Promise that resolves when sign-out is complete

##### getAccessToken

```typescript
getAccessToken(): string | null
```

Gets the current access token if a session exists.

- Returns: Access token string or null if no session

##### getSession

```typescript
getSession(): OpaqueSession
```

Gets the current authenticated session.

- Returns: An opaque session object with `isAuthenticated`, `user`, `expiresAt`, and `role`

##### hasRefreshToken

```typescript
hasRefreshToken(): boolean
```

Returns true if the current session has a refresh token available.

##### startAutoRefresh

```typescript
async startAutoRefresh(): Promise<void>
```

Resumes automatic token refresh.
No-op when `autoRefreshToken` is `true` (already managed).
Useful for React Native `AppState.active` transitions.

##### stopAutoRefresh

```typescript
async stopAutoRefresh(): Promise<void>
```

Pauses automatic token refresh by cancelling pending timers.
No-op when `autoRefreshToken` is `true`.

##### onAuthStateChange

```typescript
onAuthStateChange(callback: (session: Session | null) => void): () => void
```

Registers a callback function to be called when the authentication state changes.

- `callback`: Function to call with the new session or null
- Returns: Function to unsubscribe the listener

### Types

#### SignUpCredentials / SignInCredentials

```typescript
interface AuthCredentials {
  email: string;
  password: string;
  role?: string; // Optional role parameter for signup
}

// Type aliases
type SignUpCredentials = AuthCredentials;
type SignInCredentials = AuthCredentials;
```

#### SignUpResponse

```typescript
interface SignUpResponse {
  userId: string;
  email: string;
  token?: string;
  refreshToken?: string;
  role?: string;
  createdAt?: string;
}
```

#### SignInResponse

```typescript
interface SignInResponse {
  userId: string;
  email: string;
  token: string;
  refreshToken?: string;
  role?: string;
  expiresAt?: string;
}
```

#### AnonymousTokenResponse

```typescript
interface AnonymousTokenResponse {
  token: string;
  userId?: string;
  role?: string;
}
```

#### Session

```typescript
interface Session {
  user: User;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  role?: string;
}
```

#### User

```typescript
interface User {
  id: string;
  email: string;
  role?: string;
}
```

## Error Handling

The Auth API throws specific error types from the `@microsoft/rayfin-lib` package:

- `AuthError`: Authentication-specific errors (e.g., invalid credentials)
- `NetworkError`: Network-related issues
- `SdkError`: Other unexpected SDK errors

Example error handling:

```typescript
import { Auth } from '@microsoft/rayfin-auth';
import { AuthError, NetworkError, SdkError } from '@microsoft/rayfin-lib';

try {
  await auth.signIn(credentials);
} catch (error) {
  if (error instanceof AuthError) {
    console.error('Authentication error:', error.message, error.code);
    // Handle auth errors (wrong password, etc.)
  } else if (error instanceof NetworkError) {
    console.error('Network error:', error.message);
    // Handle network issues
  } else if (error instanceof SdkError) {
    console.error('SDK error:', error.message);
    // Handle other SDK errors
  } else {
    console.error('Unknown error:', error);
  }
}
```

## Implementation Notes

- The Auth API uses stateless JWT authentication
- Tokens are not stored in the database but managed client-side
- Session state is tracked for security and invalidation purposes
- The API supports both authenticated users and anonymous access
