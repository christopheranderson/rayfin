# Microsoft Entra External ID

## Overview

Microsoft Entra External ID is Microsoft's Customer Identity and Access Management (CIAM) solution, enabling developers to add authentication to consumer and business customer applications. It provides self-service registration, personalized sign-in experiences, and customer account management in a tenant separate from your organization tenant.
Scenarios:

- Developer creating consumer apps, use External ID to quickly add authentication and customer identity and access management (CIAM) to your application. Register your app, customize.
 Tenant is separate from the org tenant.
- Employees to collaborate with business partners and guests, use External ID for B2B collaboration. Secure access to enterprice apps, authz in the same tenant as org.

---

## Setup Steps

Following are the steps to setup authentication using Microsoft Entra external id. All the steps can be done from portal or using Graph and Entra apis.

- Prerequisites:
  - Need to have a Microsoft (Workspace) Tenant and subscription to start off.
  - User needs to have Tenant Creator role to create the external tenant.

### 1. Create an External Tenant

With External ID, you create a distinct tenant that follows the standard Microsoft Entra tenant model but is configured for external scenarios.

- User needs Tenant Creator permission for this step.
- The tenant contains the directory storing customer credential and profile data, app registration, sign in/ sign up flows, encryption keys etc.

### 2. Register Your Application

Register your SPA or web app in the external tenant to obtain a **Client ID**. Configure:

- Redirect URIs for your application
- For web apps, set up certificate or other secrets in the app.
- For web apps, set delegated permissions for Microsoft Graph openid and offline access permissions. This is used to access details regarding the user profile when they are signed in.
- As part of getting the permissions, select "Grant admin consent for tenant" in order to approve the external users.

### 3. Configure User Flows

A user flow defines the series of sign-up steps customers follow and the sign-in methods they can use (such as email and password, one-time passcodes, or social accounts from Google or Facebook)

- This is set in the external identities configuration and can be associated with multiple app registrations.
- Default is email/password
- Social auth can be configured by setting up auth with Google/Facebook etc.
- Conditional access settings can help configure MFA.
- Custom authentication extensions provide further flexibility in extra verification before sign up or sign in.
- Custom extensions also provide ability to setup custom token issurance endpoints that can be used for issueing tokens with custom claims.

### 4. Customize Branding

Custom attributes can be set for collection during the user signup scenario along with built in attributes like email, name etc.
The branding around the Sign up/Sign in page can also be updated by adding banners, favicons, footers and headers.

---

## Required Permissions for Setup

The following table lists the minimum permissions required for each External ID setup action:

| Action | Required Permission | Scope | Notes |
|--------|-------------------|-------|-------|
| **Create External Tenant** | Tenant Creator | Organization tenant | One-time action; creates separate CIAM tenant |
| **Register Application** | Application Administrator or Cloud Application Administrator | External tenant | Can also use Application Developer for own apps |
| **Configure Redirect URIs** | Application Administrator or owner of app registration | External tenant | Application owner has full control of their app |
| **Add API Permissions** | Application Administrator or owner of app registration | External tenant |  |
| **Grant Admin Consent** | Cloud Application Administrator, Application Administrator, or custom role with permission to grant consent | External tenant | Required for delegated permissions like `User.Read` |
| **Create/Edit User Flows** | External ID User Flow Administrator or External Identity Provider Administrator | External tenant | Manages sign-up/sign-in experiences |
| **Configure Social Identity Providers** | External Identity Provider Administrator | External tenant | For Google, Facebook, etc. integration |
| **Set Conditional Access Policies** | Conditional Access Administrator or Security Administrator | External tenant | For MFA and security policies |
| **Add Custom Attributes** | User Administrator or External ID User Flow Administrator | External tenant | Collect custom data during sign-up |
| **Customize Branding** | External ID User Flow Administrator | External tenant | Logo, colors, messaging on sign-in pages |
| **Configure Custom Authentication Extensions** | Authentication Extensibility Administrator | External tenant | For custom claims and advanced scenarios |

---

## Service Limits & Quotas

The following service limits and operational behaviors can affect applications using Microsoft Entra External ID. Design for resilience (retry, backoff, caching) and monitor usage against these boundaries. Numbers marked (default) are configurable only in limited scenarios; always verify current limits in official documentation as they may evolve.

| Category | Limit / Behavior | Applies To | Impact on App | Mitigation / Guidance |
|----------|------------------|-----------|---------------|------------------------|
| Authentication throughput | ~200 requests/sec (soft service limit) | Per External ID tenant | High concurrent logins may experience latency or throttling | Stagger login waves; implement exponential backoff on 429; avoid redundant silent token calls |
| Total number of objects (user accounts and applications) per trial tenant | 10000 | Per Tenant | Cannot sign up new users | Upgrade to paid plan |
| Total number of objects (user accounts and applications) per tenant | 300000 | Per Tenant | Cannot sign up new users | Contact support for qouta increase |
| Total number of texts per day | 1000 | Per tenant |  Text messages for sign in, MFA etc will get throttled |  |

---

## Authentication Flow

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Authentication Flow                         │
└─────────────────────────────────────────────────────────────────┘

1. User Initiates Login
   ┌──────────┐
   │  React   │ ──────► useMsal().instance.loginRedirect()
   │   SPA    │
   └──────────┘

2. Redirect to Microsoft Entra External ID
   ┌──────────┐         ┌─────────────────────────────┐
   │   SPA    │ ───────►│  Microsoft Entra External   │
   └──────────┘         │  ID Login Page              │
                        │  (tenant.ciamlogin.com)     │
                        └─────────────────────────────┘

3. User Authenticates (Email/Password, Social, etc.)
   ┌─────────────────────────────┐
   │  Microsoft Entra External   │
   │  ID                         │
   │  • Validates credentials    │
   │  • Applies MFA (if enabled) │
   │  • Issues tokens            │
   └─────────────────────────────┘

4. Redirect Back with Authorization Code
   ┌─────────────────────────────┐         ┌──────────┐
   │  Microsoft Entra External   │ ───────►│   SPA    │
   │  ID                         │         └──────────┘
   └─────────────────────────────┘

5. MSAL Exchanges Code for Tokens
   ┌──────────┐         ┌─────────────────────────────┐
   │   SPA    │ ───────►│  Microsoft Entra External   │
   │  (MSAL)  │         │  ID Token Endpoint          │
   └──────────┘         └─────────────────────────────┘
                                    │
                                    ▼
                        Returns: ID Token + Access Token + Refresh Token

6. Store Tokens in Browser Session Storage
   ┌──────────┐
   │   SPA    │  sessionStorage.setItem('msal.tokens', ...)
   │  (MSAL)  │
   └──────────┘

7. Make API Calls with Access Token
   ┌──────────┐         Authorization: Bearer {access_token}
   │   SPA    │ ─────────────────────────────────────────────┐
   └──────────┘                                               │
                                                              ▼
                                                    ┌──────────────────┐
                                                    │  ASP.NET Core    │
                                                    │  API             │
                                                    └──────────────────┘

8. API Validates Token and Extracts User Identity
   ┌──────────────────┐
   │  ASP.NET Core    │  • Validates JWT signature
   │  API             │  • Checks expiration, audience, issuer
   │                  │  • Extracts 'sub' claim (user ID)
   │                  │  • Populates HttpContext.User
   └──────────────────┘

9. API Filters Data by User ID
   ┌──────────────────┐         ┌──────────────────┐
   │  Controller      │ ───────►│   Repository     │
   │  userId = User   │         │   WHERE UserId   │
   │  .Identity.Name  │         │   = @userId      │
   └──────────────────┘         └──────────────────┘

10. Return User-Specific Data
   ┌──────────────────┐         ┌──────────┐
   │  ASP.NET Core    │ ───────►│   SPA    │
   │  API             │         │          │
   └──────────────────┘         └──────────┘
```

---

## Frontend Integration (React SPA)

### 1. Install MSAL Libraries

```bash
npm install @azure/msal-browser @azure/msal-react
```

### 2. Configure MSAL

```typescript
// authConfig.ts
import { Configuration } from '@azure/msal-browser';

export const msalConfig: Configuration = {
  auth: {
    authority: 'https://<tenant-name>.ciamlogin.com/<tenant-id>',
    clientId: '<your-client-id>',
    redirectUri: 'http://localhost:5173',
  },
  cache: {
    cacheLocation: 'localStorage', // or 'sessionStorage'
    storeAuthStateInCookie: false,
  }
};

export const loginRequest = {
  scopes: ['openid', 'profile', 'offline_access']
};
```

### 3. Initialize MSAL Provider

```tsx
// main.tsx
import { MsalProvider } from '@azure/msal-react';
import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from './config/authConfig';

const msalInstance = new PublicClientApplication(msalConfig);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <MsalProvider instance={msalInstance}>
    <App />
  </MsalProvider>
);
```

### 4. Implement Sign-In/Sign-Out

```tsx
// Using hooks
import { useMsal } from '@azure/msal-react';
import { loginRequest } from './config/authConfig';

function LoginButton() {
  const { instance } = useMsal();

  const handleLogin = () => {
    instance.loginRedirect(loginRequest);
  };

  const handleLogout = () => {
    instance.logoutRedirect();
  };

  return (
    <>
      <button onClick={handleLogin}>Sign In</button>
      <button onClick={handleLogout}>Sign Out</button>
    </>
  );
}
```

### 5. Get Access Tokens for API Calls

```typescript
// Token acquisition with silent/interactive fallback
const getAccessToken = async (): Promise<string> => {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) throw new Error('No accounts found');

  try {
    const response = await msalInstance.acquireTokenSilent({
      scopes: ['api://<api-client-id>/access'],
      account: accounts[0]
    });
    return response.accessToken;
  } catch (error) {
    // Fallback to interactive login if silent fails
    const response = await msalInstance.acquireTokenRedirect({
      scopes: ['api://<api-client-id>/access']
    });
    return response.accessToken;
  }
};
```

### 6. Attach Tokens to HTTP Requests

```typescript
// Axios interceptor
import axios from 'axios';

const httpClient = axios.create({
  baseURL: 'https://api.example.com'
});

httpClient.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});
```

---

## Backend Integration (ASP.NET Core)

### 1. Install NuGet Package

```bash
dotnet add package Microsoft.Identity.Web
```

### 2. Configure JWT Authentication

```csharp
// Program.cs
using Microsoft.Identity.Web;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));

builder.Services.AddAuthorization();

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();
```

**appsettings.json**:

```json
{
  "AzureAd": {
    "Instance": "https://<tenant-name>.ciamlogin.com/",
    "TenantId": "<tenant-id>",
    "ClientId": "<api-client-id>",
    "Audience": "api://<api-client-id>"
  }
}
```

### 3. Protect API Endpoints

```csharp
[Authorize]
[ApiController]
[Route("api/[controller]")]
public class TodosController : ControllerBase
{
    [HttpGet]
    public IActionResult GetTodos()
    {
        // This endpoint requires a valid JWT token
        return Ok(todos);
    }
}
```

### 4. Extract User Identity from Token

```csharp
// Get the unique user identifier from token claims
var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value 
          ?? User.FindFirst("sub")?.Value
          ?? User.FindFirst("oid")?.Value;
```

---

## Takeaways

### Local Development

- No local offering for Entra External ID is available
- Following developer configuration is required to work with Entra External ID for app development
  - External tenant: The user need to be made admin to manage signups in the Entra portal
  - The user needs to have appropriate permissions on the external tenant scope.
  - Rayfin Control plane can do the set up to do create the external tenant, do app registration, and perform the remaining configurations using Entra/Graph APIS. It will require the appropriate permissions.

### Self-Hosted

- Require an Azure Workspace Tenant and subscription.
- Tenant admin can create External tenant for the hosted app.
- The Signed up user is created as an identity on the external tenant. This means that only apps
that are ok with sharing the user should be hosted using the same External ID configuration.
- Need to be aware of and handle the Azure service limits.
- Rayfin Control plane can do the set up to do create the external tenant, do app registration, and perform the remaining configurations using Entra/Graph APIS. It will require the appropriate permissions.

### Fabric Hosted

- Fabric customers already have a workspace tenant.
- External tenant still needs to be provisioned.
- Each Rayfin project needs to have it's own tenant if it does not intend to share users.
- Azure service limits will still apply.

---

### Key Benefits

- **Rapid Integration**: Add authentication with minimal code using MSAL libraries
- **Secure by Default**:
  - Industry-standard OAuth 2.0 and OpenID Connect protocols.
  - Rayfin does not need to worry about saving passwords.
  - MSAL can be used to handle tokens.
- **Flexible User Flows**: Email/password, social accounts (Google, Facebook), and passwordless options
- **Customizable**: Brand the sign-in experience and collect custom user attributes and add custom claims.

### Challenges

- **Not Entirely local**: No entirely local auth option for local hosting.
- **Dependency on Microsoft tenant**: Microsoft tenant is mandatory for even local and self hosted options.
- **Azure Service limits might hit fast**: Certain limits like 200 Sign-in requests/second/tenant and SMS limits might hit faster for some apps.
- **Auth URL is not branded**: The Entra Authority is the following <https://your-tenant-id-here.ciamlogin.com/your-tenant-id-here/v2.0>. Extra steps are required to
create a custom domain which offers better security, trust and branding.

---

## Conclusion

From the above research, Microsoft Entra External ID is a full-featured
CIAM solution that provides OAuth and social identity provider support,
branded user flows, and tenant-scaled identity management suitable for
production deployments.

For Rayfin, Microsoft Entra External ID will not be used for the following reasons:

- Architectural Friction with Data & RLS: In Rayfin Native Auth, we provide a way to synchronize customer's app database with Users and Sessions information. With Entra in the mix, given that it will be a closed system, the replication will require constant API calls to entra to fetch and reconcile user details.
- Vendor Lock-in and Community Perception: One of the tenets of Rayfin is to be a self-hostable OSS framework. A hard dependency on entra will lead to Vendor Lock-in and community perception with see it as tightly coupled with Azure.
- Local and Self-Hosted Development experience: The initial phases are intentionally focused on local and self-hosted developer experiences that must not require an Azure/Microsoft tenant
or other external service dependencies. Requiring an External ID tenant, tenant-level permissions etc would create a blocker for the target developer workflows for these phases.
- Cost Model: For self-hosting, customers on on-prem or other cloud providers will have to account for extra cost factor from Microsoft given the dependency on Entra.

In the interim, the recommended approach is to:

- Keep the authentication implementation lightweight and local-first for
  Phases 1 and 2.
- Provide a pluggable auth abstraction so a production CIAM provider can
  be integrated in future phases.

This keeps the developer experience smooth for local and self-hosted scenarios while preserving a clean upgrade path to provide OAuth and social provider capabilities in later phases.

See the Rayfin auth proposal for phase details: [Phases](https://github.com/microsoft/project-rayfin/blob/main/docs/rfc/rayfin-auth-capabilities.md#proposal).

---

## Resources

- [Microsoft Entra External ID Documentation](https://learn.microsoft.com/entra/external-id/)
- [MSAL.js Documentation](https://github.com/AzureAD/microsoft-authentication-library-for-js)
- [Microsoft.Identity.Web Documentation](https://learn.microsoft.com/entra/msal/dotnet/microsoft-identity-web/)
- [Service Limits](https://learn.microsoft.com/en-us/entra/external-id/customers/reference-service-limits)
- [Custom URL Domain](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-custom-url-domain)
