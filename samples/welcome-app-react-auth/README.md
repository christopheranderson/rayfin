# Welcome App with Authentication

A full-featured Rayfin sample application demonstrating authentication, data persistence, and user-owned timestamp tracking with a Radix-based UI component library.

## Features

- **Dual Authentication**: Username/password locally, Fabric Entra when deployed
- **User Ownership**: Timestamps are private to each user via DAB policy enforcement
- **Radix UI Components**: 45+ production-ready UI components styled with Tailwind CSS
- **TypeScript**: Full type safety with Rayfin decorators and schema types
- **Rayfin Integration**: Backend connectivity with auth and data services

## Getting Started

### Prerequisites

- Node.js 20+
- Microsoft Fabric access

### Installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Provision or reuse the Fabric backend and start the local dev server:

   ```bash
   npm run dev
   ```

3. Open your browser to the Vite dev server URL shown in the terminal.

### Testing Against a Deployed Backend

To run the frontend locally against a production (Fabric-deployed) backend:

```bash
npm run dev:fabric
```

This reads `rayfin/.env` (populated from `rayfin/.deployments.json` when you run `rayfin up`) and enables Fabric Entra authentication.

## Project Structure

```text
welcome-app-react-auth/
├── rayfin/
│   ├── data/
│   │   ├── Timestamp.ts      # Entity with decorators and user ownership policy
│   │   └── schema.ts         # Schema export for type safety
│   └── rayfin.yml            # Rayfin configuration (auth + data enabled)
├── src/
│   ├── components/
│   │   ├── ui/               # Radix-based UI components (45+ components)
│   │   ├── AuthPage.tsx      # Auth view manager (conditionally renders auth modes)
│   │   ├── SignInForm.tsx     # Sign-in form (email/password + Fabric button)
│   │   ├── SignUpForm.tsx     # Sign-up form with validation
│   │   └── TimestampTable.tsx # Timestamp list display
│   ├── hooks/
│   │   ├── AuthContext.tsx    # Authentication state and capability flags
│   │   └── useTimestamps.ts   # Timestamp operations hook
│   ├── pages/
│   │   ├── AuthCallback.tsx   # Fabric Entra OAuth callback handler
│   │   └── Dashboard.tsx      # Main dashboard page
│   ├── services/
│   │   ├── interfaces/
│   │   │   ├── IAuthService.ts       # Auth service contracts and sub-interfaces
│   │   │   └── ITimestampService.ts  # Timestamp service contract
│   │   ├── rayfin/
│   │   │   ├── RayfinAuthService.ts          # Composite auth service with builder
│   │   │   ├── RayfinUsernameAuthService.ts  # Username/password auth provider
│   │   │   ├── RayfinFabricAuthService.ts    # Fabric Entra auth provider
│   │   │   ├── RayfinClientService.ts        # Rayfin client singleton
│   │   │   └── RayfinTimestampService.ts     # Timestamp data operations
│   │   └── ServiceContainer.ts  # Service initialization with auth builder
│   ├── App.tsx                # Router setup with protected routes
│   └── main.tsx               # Entry point with providers
└── package.json
```

## Architecture

### Authentication

The auth service uses a **builder pattern** to enable the appropriate authentication providers based on the runtime environment:

- **Local development** (`localhost`): Username/password sign-in and sign-up are enabled
- **Deployed** (non-localhost with Fabric config): Fabric Entra sign-in is enabled

The `ServiceContainer` configures the builder automatically:

```typescript
const authBuilder = RayfinAuthService.builder();

if (isLocalEnvironment) {
  authBuilder.withUsernameAuth();
}

if (hasFabricConfig) {
  authBuilder.withFabricAuth({ workspaceId, projectId, fabricPortalUrl });
}
```

The auth service exposes `usernameAuthEnabled` and `fabricAuthEnabled` flags, which the UI uses to conditionally render the appropriate sign-in options.

### Auth Service Structure

- `RayfinAuthService` — Composite that delegates to enabled sub-services
- `RayfinUsernameAuthService` — Handles email/password sign-in and sign-up
- `RayfinFabricAuthService` — Handles Fabric Entra OAuth (redirect + callback)

### Data Model

The `Timestamp` entity uses Rayfin decorators with a user ownership policy:

```typescript
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Timestamp {
  @uuid() id!: string;
  @date() timestamp!: Date;
  @date() createdAt!: Date;
  @text() user_id!: string;
}
```

This ensures users can only access their own timestamps, enforced at the database query level by DAB.

### Service Layer

Services are accessed through the `ServiceContainer` singleton:

- `authService`: Authentication operations (sign in, sign up, Fabric Entra, sign out)
- `timestampService`: Timestamp CRUD operations via GraphQL

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Provision or reuse the Fabric backend and start local frontend/Functions code |
| `npm run dev:fabric` | Start only the Vite frontend using existing Fabric environment values |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm run test` | Run tests |
| `npm run rayfin:up` | Deploy app to Fabric (no local dev server) |
| `npm run rayfin:db` | Generate and apply database schema |

## UI Components

This sample includes a comprehensive set of Radix-based UI components:

- **Layout**: Card, Separator, Tabs
- **Forms**: Button, Input, Label, Form (with react-hook-form)
- **Data Display**: Table, Badge, Avatar
- **Feedback**: Alert, Toast (Sonner)
- **And 40+ more...**

All components are located in `src/components/ui/` and styled with Tailwind CSS.

## Environment Variables

All Rayfin environment variables live in `rayfin/.env` using the `RAYFIN_PUBLIC_*` prefix.
`rayfin dev` generates `.env.local` with Vite-compatible names before starting the frontend.

| Source (`rayfin/.env`) | Vite variable (`.env.local`) | Description | Default |
| --- | --- | --- | --- |
| `RAYFIN_PUBLIC_API_URL` | `VITE_RAYFIN_API_URL` | Rayfin backend URL | `http://localhost:5168` |
| `RAYFIN_PUBLIC_PUBLISHABLE_KEY` | `VITE_RAYFIN_PUBLISHABLE_KEY` | Rayfin publishable key | (generated on dev) |
| `RAYFIN_PUBLIC_ITEM_ID` | `VITE_FABRIC_ITEM_ID` | Rayfin item ID; enables managed hosting and Fabric auth | (written by `rayfin up`) |
| `RAYFIN_PUBLIC_WORKSPACE_ID` | `VITE_FABRIC_WORKSPACE_ID` | Fabric workspace ID; required for Fabric Entra auth | — |
| `RAYFIN_PUBLIC_PORTAL_URL` | `VITE_FABRIC_PORTAL_URL` | Fabric portal URL; required for Fabric Entra auth | — |

## License

See the [LICENSE](LICENSE) file for details.
