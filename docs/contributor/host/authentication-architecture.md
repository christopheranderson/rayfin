# Authentication Architecture in Rayfin

This document outlines the authentication system implemented in the Rayfin platform, which uses asymmetric JWT (ES256) for authentication and session management, combined with ASP.NET Core's attribute-based authorization.

## Overview

Rayfin's authentication system follows an OAuth 2.1-inspired approach using asymmetric JWT tokens (ES256 - ECDSA with P-256 curve) for secure, stateless authentication. This design provides several benefits:

1. **Asymmetric Cryptography**: Uses ECDSA (Elliptic Curve Digital Signature Algorithm) for enhanced security
2. **Public Key Distribution**: Public keys available via standard JWKS endpoint (/.well-known/jwks.json)
3. **Stateless Validation**: Tokens can be validated without database lookups using public keys
4. **Better Scalability**: Distributed systems can validate tokens independently
5. **OAuth 2.1 Compliant**: Token endpoint follows OAuth 2.1 standards
6. **Anonymous Access Support**: Automatic anonymous claim injection for unauthenticated requests

The system uses a **custom authentication middleware** (`RayfinAuthenticationMiddleware`) that automatically injects anonymous claims for requests without tokens. This enables a unified security model where all requests have a ClaimsPrincipal (either authenticated user or anonymous). Data controllers use `[AllowAnonymous]` and rely on the claims principal, while API controllers can reject anonymous access by not using `[AllowAnonymous]`.

## Core Components

### 1. Asymmetric JWT Authentication (ES256)

The system uses ES256 (ECDSA with P-256 curve) for JWT signing and validation:

```csharp
// Auth configuration from rayfin.yml
public class AuthSettings : ServiceConfig
{
    public const int DefaultExpiryInMinutes = 60; // 1 hour
    public const int MinExpiryInMinutes = 15;
    public const int MaxExpiryInMinutes = 43200; // 30 days

    // Configurable in rayfin.yml (range: 15-43200)
    public int ExpiryInMinutes { get; set; } = DefaultExpiryInMinutes;
    public Dictionary<string, string>? CustomClaims { get; set; }
    public List<string>? Scopes { get; set; }
    public RefreshTokenSettings? RefreshToken { get; set; }
}
```

> **Note**: `Issuer` and `Audience` are derived internally:
>
> - **Issuer**: `https://<project_id>.rayfin.io`
> - **Audience**: The project ID from `rayfin.yml`

**Key Features:**

- **Asymmetric Keys**: Uses EC (Elliptic Curve) key pairs - private key for signing, public key for validation
- **ES256 Algorithm**: ECDSA using P-256 curve and SHA-256 hash
- **Key Rotation**: Supports multiple keys with unique Key IDs (kid)
- **JWKS Endpoint**: Public keys published at `/.well-known/jwks.json` per RFC 7517

**JWT Claims Structure:**

- `sub` (Subject): User ID or "anonymous"
- `email`: User's email address (for authenticated users)
- `role`: User's role (anonymous, authenticated, admin, etc.)
- `jti` (JWT ID): Unique token identifier for session tracking
- `iat` (Issued At): Token creation timestamp
- `exp` (Expiration): Token expiration timestamp
- `iss` (Issuer): Token issuer (configured in AuthOptions)
- `aud` (Audience): Intended audience (configured in AuthOptions)

### 2. Attribute-Based Authorization

The primary security mechanism uses ASP.NET Core's built-in authorization attributes combined with Rayfin's anonymous claim injection:

```csharp
// Controller with mixed endpoint protection
[ApiController]
[Route("api/data")]
public class DataController : ControllerBase
{
    // Public endpoint - allows anonymous and authenticated users
    [HttpGet("public-query")]
    [AllowAnonymous]
    public IActionResult PublicQuery() 
    {
        // Can check if user is anonymous: User.HasClaim("role", "anonymous")
        // Or authenticated: User.Identity?.IsAuthenticated == true
        return Ok(/* data based on user context */);
    }
}

// API controller - secure by default
[ApiController]
[Route("api/auth/v1")]
public class AuthV1Controller : ControllerBase
{
    // Public endpoint - explicit [AllowAnonymous]
    [HttpPost("signup")]
    [AllowAnonymous]
    public IActionResult SignUp() { ... }

    // Protected endpoint - no [AllowAnonymous], rejects anonymous users
    [HttpPost("signout")]
    public IActionResult SignOut() 
    {
        // Anonymous users will be rejected automatically
        // Only users with valid tokens can access this
        return Ok(/* ... */);
    }
}
```

**Key Concepts:**

- **`[AllowAnonymous]`**: Explicitly marks endpoint as public (accepts both authenticated and anonymous claims)
- **No attribute / Default**: Endpoint rejects anonymous users (secure by default)
- **`[Authorize]`**: Explicitly requires authentication (optional but recommended for clarity)
- **`[Authorize(Roles = "...")]`**: Requires specific roles for access
- **`[Authorize(Policy = "...")]`**: Uses named authorization policy

**Important**: Unlike standard ASP.NET Core, Rayfin's middleware injects anonymous claims for all unauthenticated requests. Authorization is then handled by the presence or absence of `[AllowAnonymous]` attribute.

### 3. Rayfin Authentication Middleware

The `RayfinAuthenticationMiddleware` handles token validation and anonymous claim injection:

```csharp
public class RayfinAuthenticationMiddleware
{
    public async Task InvokeAsync(HttpContext context)
    {
        // Skip authentication for certain paths (e.g., /.well-known/jwks.json)
        if (ShouldSkipAuthentication(context))
        {
            await _next(context);
            return;
        }

        string? token = ExtractTokenFromHeader(context);

        if (string.IsNullOrEmpty(token))
        {
            // No token → Inject authenticated anonymous claims
            var anonymousClaims = new[]
            {
                new Claim(JwtRegisteredClaimNames.Sub, "anonymous"),
                new Claim(ClaimTypes.Role, "anonymous"),
                new Claim("role", "anonymous")
            };
            context.User = new ClaimsPrincipal(new ClaimsIdentity(anonymousClaims, "Anonymous"));
            await _next(context);
            return;
        }

        // Valid token → Validate and set authenticated user
        var validationResult = await authProvider.ValidateTokenAsync(token);
        if (validationResult.IsSuccess)
        {
            context.User = validationResult.Principal;
            await _next(context);
        }
        else
        {
            // Invalid/expired token → Return 401 Unauthorized
            await RespondWithUnauthorized(context, validationResult.ErrorMessage);
        }
    }
}
```

**Key Behaviors:**

1. **No Token Present**: Injects authenticated anonymous ClaimsPrincipal (sub="anonymous", role="anonymous")
2. **Valid Token Present**: Sets authenticated user ClaimsPrincipal with user's claims
3. **Invalid/Expired Token**: Returns 401 Unauthorized response
4. **Well-Known Paths**: Skips authentication entirely for paths like `/.well-known/jwks.json`

**Design Philosophy:**

- **All requests have a ClaimsPrincipal**: Either real user or anonymous
- **Data controllers** (marked with `[AllowAnonymous]`) accept all requests and use claims to determine access level
- **API controllers** (without `[AllowAnonymous]`) automatically reject anonymous users via ASP.NET Core authorization
- **No token handling in controllers**: Controllers only work with `HttpContext.User.Claims`

### 4. JWKS Endpoint for Public Key Distribution

The `WellKnownJwksController` provides public keys for JWT validation per RFC 7517:

```csharp
[ApiController]
[Route(".well-known")]
public class WellKnownJwksController : ControllerBase
{
    /// <summary>
    /// Returns the JSON Web Key Set (JWKS) containing public keys for JWT verification.
    /// </summary>
    /// <remarks>
    /// This endpoint returns the public keys used to verify JWT signatures.
    /// Example response (ES256):
    /// {
    ///   "keys": [{
    ///     "kty": "EC",
    ///     "use": "sig",
    ///     "kid": "rayfin-auth-key-2024",
    ///     "alg": "ES256",
    ///     "crv": "P-256",
    ///     "x": "base64url-encoded-x-coordinate",
    ///     "y": "base64url-encoded-y-coordinate"
    ///   }]
    /// }
    /// </remarks>
    [HttpGet("jwks.json")]
    public async Task<IActionResult> GetJwks() { ... }
}
```

**Key Features:**

- Standard RFC 7517 JWKS format
- Supports multiple keys with unique `kid` (Key ID)
- Enables token validation without shared secrets
- Essential for distributed systems and third-party integrations

### 5. OAuth 2.1 Token Endpoint

The `AuthV1Controller` provides OAuth 2.1 compliant authentication endpoints:

```csharp
[ApiController]
[Route("api/auth/v1")]
public class AuthV1Controller : ControllerBase
{
    /// <summary>
    /// Registers a new user (does NOT return token - call /token after signup)
    /// </summary>
    [HttpPost("signup")]
    [AllowAnonymous]
    public async Task<IActionResult> SignUp([FromBody] SignUpRequest request) { ... }

    /// <summary>
    /// OAuth 2.1 token endpoint supporting password grant type
    /// </summary>
    [HttpPost("token")]
    [AllowAnonymous]
    public async Task<IActionResult> Token([FromBody] TokenRequest request) { ... }

    /// <summary>
    /// Revokes an access token (RFC 7009 compliant - requires authentication)
    /// </summary>
    [HttpPost("signout")]
    [Consumes("application/x-www-form-urlencoded")]
    public async Task<IActionResult> SignOut([FromForm] string token, [FromForm] string? token_type_hint = null) { ... }

    /// <summary>
    /// Revokes all user sessions (requires authentication)
    /// </summary>
    [HttpPost("signout-all")]
    public async Task<IActionResult> SignOutAll() { ... }
}
```

**Key Design Decisions:**

1. **Signup Returns No Token**: `/signup` creates the account but doesn't return a token
   - Supports future email verification workflows
   - Clients must call `/token` with `grant_type=password` to get access token

2. **OAuth 2.1 Token Endpoint**: `/token` follows OAuth 2.1 standards
   - Currently supports: `grant_type=password` (Resource Owner Password Credentials)
   - Future support: `grant_type=refresh_token`, `grant_type=authorization_code`

3. **Token Revocation (RFC 7009)**: `/signout` and `/signout-all` have no `[AllowAnonymous]`
   - Automatically reject anonymous users via ASP.NET Core authorization
   - Secure by default - only valid token holders can sign out
   - `/signout` follows RFC 7009 OAuth 2.0 Token Revocation standard
   - Uses `application/x-www-form-urlencoded` content type with form parameters
   - Returns 200 OK regardless of token validity (prevents token scanning attacks)

4. **No Anonymous Token Endpoint**: No public endpoint for anonymous tokens
   - Anonymous access handled transparently by middleware
   - Sub-services (like DAB) receive claims context, not tokens

### 6. RFC 7009 Token Revocation

The signout endpoint implements OAuth 2.0 Token Revocation (RFC 7009) for standards-compliant token management:

**Key Requirements:**

```csharp
[HttpPost("signout")]
[Consumes("application/x-www-form-urlencoded")]  // RFC 7009 mandated content type
public async Task<IActionResult> SignOut(
    [FromForm] string token,                      // REQUIRED: token to revoke
    [FromForm] string? token_type_hint = null)    // OPTIONAL: token type hint
{
    // Client authenticates via Authorization header
    var authenticatedUserId = User.FindFirstValue(JwtRegisteredClaimNames.Sub);
    
    // Validate and revoke token if it belongs to authenticated user
    // ...
    
    // RFC 7009 Section 2.2: ALWAYS return 200 OK
    return Ok();
}
```

**Security Benefits:**

1. **Prevents Token Scanning**: Always returning 200 OK prevents attackers from determining token validity
2. **Client Authentication**: Requires valid Authorization header (prevents unauthorized revocation attempts)
3. **User Isolation**: Users can only revoke their own tokens (validated by comparing JWT claims)
4. **Standards Compliance**: Follows OAuth 2.0 Token Revocation specification exactly

**Request Example:**

```http
POST /api/auth/v1/signout HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJFUzI1NiIs...
Content-Type: application/x-www-form-urlencoded

token=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...&token_type_hint=access_token
```

**Response (Always 200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

### 7. Pluggable Authentication Provider

The `IAuthenticationProvider` interface enables different authentication strategies:

```csharp
public interface IAuthenticationProvider
{
    Task<AuthenticationResult> AuthenticateUserAsync(string email, string password);
    Task<TokenValidationResult> ValidateTokenAsync(string token);
    Task<TokenGenerationResult> GenerateTokenAsync(Guid userId, string email, string role);
    Task<TokenRevocationResult> RevokeTokenAsync(string token);
    // Other methods...
}
```

**Current Implementation:**

- `EmailPasswordAuthenticationProvider`: Email/password authentication with asymmetric JWT (ES256)

**Future Implementations:**

- OAuth providers (Google, Microsoft, GitHub)
- SAML authentication
- Magic link authentication

## Authentication Flow

### 1. User Registration (Sign Up)

When a user signs up:

1. The client sends email and password to `/api/auth/v1/signup`
2. The server validates the request and creates a new user record
3. **No token is returned** (to support future email verification)
4. The client must then call `/api/auth/v1/token` with `grant_type=password` to obtain a token

**Response (Signup):**

```json
{
    "userId": "00000000-0000-0000-0000-000000000000",
  "email": "user@example.com",
  "message": "User registered successfully. Please call /token to get access token."
}
```

### 2. Token Issuance (OAuth 2.1)

When requesting an access token:

1. The client sends credentials to `/api/auth/v1/token` with `grant_type=password`
2. The server validates credentials
3. A session record is created in the database
4. An asymmetric JWT (ES256) is generated and signed with the private key
5. The token is returned to the client

**Request (Token):**

```json
{
  "grant_type": "password",
  "email": "user@example.com",
  "password": "securePassword123"
}
```

**Response (Token):**

```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJheWZpbi1hdXRoLWtleS0yMDI0In0...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "read:data write:data"
}
```

### 3. Anonymous Access (Transparent)

For unauthenticated users:

1. The client makes a request **without** an Authorization header
2. The middleware automatically injects anonymous claims (sub="anonymous", role="anonymous")
3. Endpoints marked with `[AllowAnonymous]` accept the request
4. Endpoints without `[AllowAnonymous]` reject with 401 Unauthorized

**No explicit anonymous token endpoint** - anonymous access is handled transparently by the middleware.

### 4. Token Validation

When any endpoint is accessed:

1. The middleware extracts the JWT token from the Authorization header
2. The token signature is validated using the public key from `IKeyProvider`
3. Token expiration and other claims are validated
4. If valid, the user's ClaimsPrincipal is set on HttpContext
5. If invalid/expired, 401 Unauthorized is returned

**Public Key Verification:**

- Clients can fetch public keys from `/.well-known/jwks.json`
- No shared secrets needed - asymmetric cryptography

### 5. Token Revocation (RFC 7009)

When a user signs out:

1. The client sends a revocation request to `/api/auth/v1/signout` (requires authentication)
2. Anonymous users are automatically rejected (no `[AllowAnonymous]`)
3. The request uses `application/x-www-form-urlencoded` content type with form parameters
4. The server validates the user's Authorization header token (client authentication)
5. The server extracts and validates the token to be revoked
6. If the token belongs to the authenticated user, the session is invalidated
7. The server **always returns 200 OK**, regardless of token validity (RFC 7009 security measure)

**RFC 7009 Compliance:**

- **Content-Type**: `application/x-www-form-urlencoded` (REQUIRED per RFC 7009)
- **Parameters**:
  - `token` (REQUIRED): The token to revoke
  - `token_type_hint` (OPTIONAL): Hint about token type (e.g., "access_token")
- **Client Authentication**: Via Authorization header Bearer token
- **Response**: Always 200 OK (prevents token scanning attacks)
- **Security**: Users can only revoke their own tokens

**Sign Out All Sessions:**

The `/api/auth/v1/signout-all` endpoint revokes all active sessions for the authenticated user:

- Gets user ID from Authorization header
- Invalidates all sessions for that user
- Returns count of revoked sessions

## Request Processing Pipeline

1. **Request Arrives**: HTTP request enters the middleware pipeline

2. **CORS Middleware**: Built-in CORS middleware handles cross-origin requests

3. **RayfinAuthenticationMiddleware**:
   - **Checks special paths**: Skips authentication for `/.well-known/jwks.json`
   - **Extracts token**: Reads `Authorization: Bearer {token}` header
   - **Three scenarios**:
     - **No token**: Injects authenticated anonymous ClaimsPrincipal (sub="anonymous", role="anonymous")
     - **Valid token**: Validates using public key, sets authenticated user ClaimsPrincipal
     - **Invalid/expired token**: Returns 401 Unauthorized immediately

4. **ASP.NET Core Authorization**:
   - **All requests have a ClaimsPrincipal** (user or anonymous)
   - **Endpoints with `[AllowAnonymous]`**: Allow through (accept user or anonymous)
   - **Endpoints without `[AllowAnonymous]`**: Check if user is authenticated (reject anonymous)
   - **Role-based attributes**: Further enforce role requirements

5. **Controller Action**:
   - Controller receives request with populated `HttpContext.User`
   - Can check claims: `User.HasClaim("role", "anonymous")` or `User.Identity?.IsAuthenticated`
   - No token handling in controllers - only claims-based logic

## Endpoint Protection Mechanisms

### Anonymous Claim Injection Pattern

Rayfin uses a **unified claims-based security model** where all requests have an authenticated ClaimsPrincipal:

```csharp
// Data controller - allows anonymous and authenticated users
[ApiController]
[Route("api/data")]
public class DataController : ControllerBase
{
    [HttpGet("query")]
    [AllowAnonymous]  // Accepts both anonymous and authenticated
    public IActionResult Query()
    {
        // Check if user is anonymous
        bool isAnonymous = User.HasClaim(c => c.Type == "role" && c.Value == "anonymous");
        return Ok(isAnonymous ? PublicData() : PersonalizedData());
    }
}

// API controller - rejects anonymous by default
[ApiController]
[Route("api/auth/v1")]
public class AuthV1Controller : ControllerBase
{
    [HttpPost("signup")]
    [AllowAnonymous]  // Public endpoint
    public IActionResult SignUp() { ... }

    [HttpPost("signout")]
    // No [AllowAnonymous] → Rejects anonymous users automatically
    public IActionResult SignOut() { ... }
}
```

### Best Practices

1. **`[AllowAnonymous]` = Public Endpoint**: Mark data query endpoints that accept anonymous access
2. **No `[AllowAnonymous]` = Protected**: Endpoints without the attribute reject anonymous users
3. **Avoid Class-Level `[AllowAnonymous]`**: Apply it only to specific actions, not entire controllers
4. **Check Claims in Controllers**: Use `User.HasClaim("role", "anonymous")` to differentiate access levels
5. **Never Handle Tokens in Controllers**: Only read `HttpContext.User.Claims`

### Role-Based Access Control

```csharp
// Direct role check
[Authorize(Roles = "Admin,Manager")]
public IActionResult AdminAction() { ... }

// Policy-based
[Authorize(Policy = "AdminPolicy")]
public IActionResult PolicyAction() { ... }

// Programmatic
if (User.IsInRole("Admin")) { ... }
```

## Sequence Diagrams

### Sign Up and Token Issuance Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Database

    Note over Client,Database: 1. Sign Up (no token returned)
    Client->>Server: POST /api/auth/v1/signup {email, password}
    Server->>Database: Create user record
    Database-->>Server: User created
    Server-->>Client: 200 OK {userId, email, message}

    Note over Client,Database: 2. Get Token (OAuth 2.1)
    Client->>Server: POST /api/auth/v1/token<br/>{grant_type:"password", email, password}
    Server->>Database: Validate credentials
    Server->>Server: Generate ES256 JWT
    Server->>Database: Create session record
    Server-->>Client: 200 OK {access_token, token_type, expires_in, scope}
```

### Request Processing with Anonymous Claims

```mermaid
sequenceDiagram
    participant Client
    participant Middleware
    participant Controller

    Client->>Middleware: HTTP Request
    
    alt No Authorization header
        Middleware->>Middleware: Inject anonymous ClaimsPrincipal
        Middleware->>Controller: Forward with anonymous claims
        alt Has [AllowAnonymous]
            Controller-->>Client: 200 OK (public data)
        else No [AllowAnonymous]
            Controller-->>Client: 401 Unauthorized
        end
    else Has Bearer token
        Middleware->>Middleware: Validate JWT (ES256 + public key)
        alt Valid token
            Middleware->>Controller: Forward with user claims
            Controller-->>Client: 200 OK (personalized data)
        else Invalid token
            Middleware-->>Client: 401 Unauthorized
        end
    end
```

### Anonymous Access Flow (Transparent)

```mermaid
sequenceDiagram
    participant Client
    participant Middleware
    participant Controller

    Client->>Middleware: Request without Authorization header
    Middleware->>Middleware: No token found
    Middleware->>Middleware: Inject anonymous ClaimsPrincipal<br/>(sub="anonymous", role="anonymous")
    Middleware->>Controller: Forward request with anonymous claims
    alt Endpoint has [AllowAnonymous]
        Controller->>Controller: Check User.Claims["role"] == "anonymous"
        Controller-->>Client: 200 OK with public data
    else Endpoint has no [AllowAnonymous]
        Controller-->>Client: 401 Unauthorized<br/>(ASP.NET Core rejects anonymous)
    end
```

### Token Validation Flow

```mermaid
sequenceDiagram
    participant Client
    participant Middleware
    participant KeyProvider
    participant Database

    Client->>Middleware: Request with Authorization: Bearer {token}
    Middleware->>Middleware: Extract JWT from header
    Middleware->>KeyProvider: Get public key for token's kid
    KeyProvider-->>Middleware: EC public key (P-256)
    Middleware->>Middleware: Validate JWT signature (ES256)<br/>and expiration
    alt Invalid token or expired
        Middleware-->>Client: 401 Unauthorized
    else Valid token
        Middleware->>Middleware: Extract claims (userId, role, jti)
        Middleware->>Database: Check if session (jti) is valid
        Database-->>Middleware: Session status
        alt Session invalidated
            Middleware-->>Client: 401 Unauthorized
        else Session valid
            Middleware->>Middleware: Set ClaimsPrincipal on context
            Middleware->>Middleware: Continue to controller
        end
    end
```

### Sign Out Flow (RFC 7009 Token Revocation)

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Database

    Client->>Server: POST /api/auth/v1/signout<br/>Authorization: Bearer {auth_token}<br/>Content-Type: application/x-www-form-urlencoded<br/>Body: token={token_to_revoke}&token_type_hint=access_token
    Server->>Server: Validate auth_token (client authentication)
    Server->>Server: Validate token_to_revoke and extract jti
    Server->>Server: Check: Does token_to_revoke belong to authenticated user?
    alt Token belongs to user
        Server->>Database: Invalidate session (jti)
        Database-->>Server: Session invalidated
    else Token invalid or belongs to another user
        Server->>Server: No action (security - don't reveal token info)
    end
    Server-->>Client: 200 OK (always, per RFC 7009)
```

### Sign Out All Sessions Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Database

    Client->>Server: POST /api/auth/v1/signout-all<br/>Authorization: Bearer {token}
    Server->>Server: Validate token and extract userId
    Server->>Database: Invalidate all sessions for userId
    Database-->>Server: Number of sessions invalidated
    Server-->>Client: 200 OK { count: N }
```

### Request Processing Pipeline Flow

```mermaid
sequenceDiagram
    participant Client
    participant CORS
    participant RayfinAuthMiddleware
    participant ASPNetAuth
    participant Controller

    Client->>CORS: HTTP Request
    CORS->>RayfinAuthMiddleware: Pass request
    RayfinAuthMiddleware->>RayfinAuthMiddleware: Check if special path<br/>(e.g., /.well-known/jwks.json)
    alt Special path
        RayfinAuthMiddleware->>Controller: Skip authentication
    else Normal path
        RayfinAuthMiddleware->>RayfinAuthMiddleware: Extract Authorization header
        alt No token
            RayfinAuthMiddleware->>RayfinAuthMiddleware: Inject anonymous ClaimsPrincipal<br/>(authenticated with "Anonymous" type)
            RayfinAuthMiddleware->>ASPNetAuth: Continue with anonymous claims
        else Has token
            RayfinAuthMiddleware->>RayfinAuthMiddleware: Validate JWT with public key
            alt Invalid/expired token
                RayfinAuthMiddleware-->>Client: 401 Unauthorized
            else Valid token
                RayfinAuthMiddleware->>RayfinAuthMiddleware: Set user ClaimsPrincipal
                RayfinAuthMiddleware->>ASPNetAuth: Continue with user claims
            end
        end
    end
    ASPNetAuth->>ASPNetAuth: Check endpoint authorization
    alt Endpoint has [AllowAnonymous]
        ASPNetAuth->>Controller: Allow (user or anonymous)
    else Endpoint has no [AllowAnonymous]
        alt User is anonymous
            ASPNetAuth-->>Client: 401 Unauthorized
        else User is authenticated
            ASPNetAuth->>Controller: Allow
        end
    end
    Controller-->>Client: Action result
```

## Database Schema

**Users Table**: User accounts

- Id, Email (unique), PasswordHash, PasswordSalt, Role, CreatedAt, UpdatedAt

**Sessions Table**: Session tracking (no token storage)

- Id, UserId (FK), JwtId (jti), CreatedAt, ExpiresAt, IsAuthenticated

## Token Structure

**JWT Header (ES256)**:

```json
{
  "alg": "ES256",
  "typ": "JWT",
  "kid": "rayfin-auth-key-2024"
}
```

**JWT Claims**:

```json
{
  "sub": "user-id-or-anonymous",
  "email": "user@example.com",
  "role": "authenticated",
  "jti": "unique-session-id",
  "iat": 1699401234,
  "exp": 1699487634,
  "iss": "https://rayfin.io",
  "aud": "https://api.rayfin.io"
}
```

**Note**: Anonymous tokens are generated internally by middleware (never exposed to clients).

## TypeScript Auth API

The `@microsoft/rayfin-auth` package provides client-side authentication functionality:

```typescript
// Example usage
import { Auth } from '@microsoft/rayfin-auth';
import { ApiClient } from '@microsoft/rayfin-lib';

const apiClient = new ApiClient({ baseUrl: 'https://api.example.com' });
const auth = new Auth(apiClient);

// Sign up (does NOT return token)
const signUpResponse = await auth.signUp({
  email: 'user@example.com',
  password: 'securePassword123',
});
// Response: { userId, email, message }

// Get token (OAuth 2.1 password grant)
const tokenResponse = await auth.getToken({
  grant_type: 'password',
  email: 'user@example.com',
  password: 'securePassword123',
});
// Response: { access_token, token_type, expires_in, scope }

// Sign out (RFC 7009 compliant - revokes a specific token)
await auth.signOut(tokenToRevoke);
// Note: Uses application/x-www-form-urlencoded format with form parameters
// Always receives 200 OK response per RFC 7009

// Sign out from all devices (revokes all user sessions)
await auth.signOutAll();
// Response: { count: number_of_revoked_sessions }

// Get current session
const session = auth.getSession();

// Listen for auth state changes
const unsubscribe = auth.onAuthStateChange((session) => {
    console.log('Auth state changed:', session);
});
```

**Note**: Anonymous access is handled automatically by the server. Clients simply make requests without Authorization headers to access public endpoints marked with `[AllowAnonymous]`. No client-side anonymous token management is required.

## Configuration

Authentication settings are configured in your project's `rayfin/rayfin.yml` file:

```yaml
services:
  auth:
    enabled: true
    # Token expiry in minutes (default: 60 / 1 hour)
    # Valid range: 15-43200 (30 days)
    expiryInMinutes: 60
    # Custom claims added to all tokens
    customClaims:
      tenant: "my-tenant"
    # OAuth scopes included in tokens
    scopes:
      - read:data
      - write:data
    # Refresh token settings
    refreshToken:
      # Lifetime in days (default: 90, range: 1-365)
      lifetimeInDays: 90
```

### Derived Settings (Internal)

The following settings are derived automatically and cannot be configured:

| Setting | Source | Example |
|---------|--------|---------|
| **Issuer** | Request URL | `https://localhost:5168` |
| **Audience** | Project ID from `rayfin.yml` | `todo-app` |
| **Reuse Interval** | Fixed (10 seconds) | Industry standard for replay detection |

### Configuration Reference

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `expiryInMinutes` | int | 60 | 15-43200 | Access token lifetime in minutes |
| `customClaims` | map | null | - | Key-value pairs added to all tokens |
| `scopes` | list | null | - | OAuth scopes included as `scope` claim |
| `refreshToken.lifetimeInDays` | int | 90 | 1-365 | Refresh token lifetime in days |

**Validation**: Values outside the valid range are clamped to the nearest boundary.
The CLI will warn when loading a configuration with out-of-range values.

**Note**: The backend uses ES256 (ECDSA P-256) asymmetric key signing.
Keys are generated and managed by the `IKeyProvider` implementation.

**Key Management:**

Keys are managed by `IKeyProvider` implementation:

- Private keys stored securely (Azure Key Vault, file system with encryption, etc.)
- Public keys published via `/.well-known/jwks.json`
- Support for key rotation via multiple keys with unique `kid` values
- ES256 algorithm: ECDSA with P-256 curve

## Security Considerations

1. **Asymmetric Cryptography (ES256)**: Private keys never leave server; public keys distributed via JWKS endpoint
2. **Token Security**: Includes expiration; session revocation via JWT ID (jti); HTTPS-only transmission
3. **Password Security**: Strong hashing with unique salts; never stored in plain text
4. **Anonymous Access**: Server-side claim injection; controllers check role to differentiate access levels
5. **Key Management**: Secure private key storage (Azure Key Vault, encrypted file system); support for key rotation
6. **Authorization**: `[AllowAnonymous]` required for public endpoints; secure by default
7. **RFC 7009 Token Revocation**:
   - Always returns 200 OK to prevent token scanning attacks
   - Requires client authentication via Authorization header
   - Users can only revoke their own tokens
   - Uses `application/x-www-form-urlencoded` content type per RFC 7009

## Implementation Details

**Backend (.NET)**:

- ES256 asymmetric JWT with `IAuthenticationProvider` interface
- Custom `RayfinAuthenticationMiddleware` for token validation and anonymous claim injection
- Session tracking via Entity Framework Core
- JWKS endpoint at `/.well-known/jwks.json` for public key distribution

**Frontend (TypeScript)**:

- `@microsoft/rayfin-auth` package provides client-side authentication
- OAuth 2.1 token endpoint integration
- No anonymous token management required (handled server-side)
