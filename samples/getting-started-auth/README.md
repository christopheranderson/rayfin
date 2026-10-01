# Getting Started with Auth

A Rayfin todo app with Tailwind CSS, shadcn UI components, and Fabric Entra authentication.
Each user owns their own todos via role-based access policies.
Demonstrates the Rayfin inner loop: provision or reuse a Fabric backend and run user code locally with `npm run dev`.

## Features

- **Todo Management**: Create, complete, and delete tasks backed by Rayfin Data API
- **Milestone Seeding**: Pre-populated journey milestones on first load
- **Radix UI Components**: Production-ready components styled with Tailwind CSS v4
- **Unified Development Workflow**: Apply backend state and run frontend code with one command
- **Authentication**: Fabric Entra SSO in production; mock email/password for local dev

## Getting Started

### Prerequisites

- Node.js 20+
- Microsoft Fabric access

### Start development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Provision or reuse the Fabric backend and start the local dev server:

   ```bash
   npm run dev
   ```

3. Open your browser to the Vite dev server URL shown in the terminal.

## Authentication

Authentication is enabled by default.
In a published Fabric app, users sign in via Fabric Entra SSO.
During `npm run dev`, the frontend is local while the managed backend runs in Fabric by default.

The `ServiceContainer` auto-detects the backend URL and selects the right auth service:

- **Localhost** → `MockAuthService` (email/password, auto-creates accounts)
- **Production** → `RayfinAuthService` → `RayfinFabricAuthService` (Fabric Entra)

Key auth files:

| File | Purpose |
| --- | --- |
| `rayfin/rayfin.yml` | Auth service configuration (auth, Fabric, password enabled) |
| `rayfin/data/Todo.ts` | `@role` decorator with `user_id` policy |
| `src/hooks/AuthContext.tsx` | Auth state management (React context) |
| `src/components/AuthPage.tsx` | Sign-in page |
| `src/components/MockSignInDialog.tsx` | Local dev mock sign-in dialog |
| `src/pages/AuthCallback.tsx` | Fabric Entra OAuth callback |
| `src/services/ServiceContainer.ts` | Auth service auto-selection |
| `src/services/rayfin/RayfinAuthService.ts` | Fabric auth service |
| `src/services/rayfin/RayfinFabricAuthService.ts` | Fabric Entra provider |
| `src/services/mock/MockAuthService.ts` | Local dev mock auth |
| `src/services/interfaces/IAuthService.ts` | Auth service contract |

## Project Structure

```text
getting-started-auth/
├── rayfin/
│   ├── data/
│   │   ├── Todo.ts            # Todo entity with @role policy and user_id
│   │   └── schema.ts          # Schema export for type safety
│   └── rayfin.yml             # Rayfin configuration (auth and data enabled)
├── src/
│   ├── components/
│   │   ├── ui/                # Radix-based UI components (shadcn)
│   │   ├── AuthPage.tsx       # Fabric sign-in page
│   │   ├── MockSignInDialog.tsx # Local dev mock sign-in dialog
│   │   ├── TodoForm.tsx       # New task input
│   │   ├── TodoItem.tsx       # Individual task with checkbox and delete
│   │   └── TodoList.tsx       # Todo list container
│   ├── hooks/
│   │   ├── AuthContext.tsx    # Authentication state management
│   │   ├── use-mobile.ts     # Mobile breakpoint hook
│   │   └── useTodos.ts       # Todo CRUD operations hook
│   ├── pages/
│   │   ├── AuthCallback.tsx   # Fabric Entra OAuth callback
│   │   └── Dashboard.tsx      # Main dashboard with milestones and todos
│   ├── services/
│   │   ├── interfaces/
│   │   │   ├── IAuthService.ts    # Auth service contract
│   │   │   └── ITodoService.ts    # Todo service contract
│   │   ├── mock/
│   │   │   └── MockAuthService.ts # Local dev mock auth
│   │   ├── rayfin/
│   │   │   ├── RayfinAuthService.ts       # Fabric auth service
│   │   │   ├── RayfinFabricAuthService.ts # Fabric Entra provider
│   │   │   ├── RayfinClientService.ts     # Rayfin client singleton
│   │   │   └── RayfinTodoService.ts       # Todo data operations
│   │   └── ServiceContainer.ts  # Service initialization with auth-mode detection
│   ├── ErrorFallback.tsx      # Error boundary fallback UI
│   ├── App.tsx                # Router with protected and public routes
│   └── main.tsx               # Entry point with AuthProvider
└── package.json
```

## Data Model

The `Todo` entity uses Rayfin decorators with a role-based access policy.
Each authenticated user can only access their own todos:

```typescript
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Todo {
  @uuid() id!: string;
  @text() title!: string;
  @boolean() isCompleted!: boolean;
  @date() createdAt!: Date;
  @text() user_id!: string;
}
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Provision or reuse the Fabric backend and start local frontend/Functions code |
| `npm run dev:fabric` | Start only the Vite frontend using existing Fabric environment values |
| `npm run build` | Build for production |
| `npm run lint` | Run ESLint |
| `npm run test` | Run tests |
| `npm run rayfin:up` | Deploy app to Fabric (no local dev server) |
| `npm run rayfin:db` | Generate and apply database schema |

## Environment Variables

All Rayfin environment variables live in `rayfin/.env` using the `RAYFIN_PUBLIC_*` prefix.
`rayfin dev` generates `.env.local` with Vite-compatible names before starting the frontend.

| Source (`rayfin/.env`) | Vite variable (`.env.local`) | Description | Default |
| --- | --- | --- | --- |
| `RAYFIN_PUBLIC_API_URL` | `VITE_RAYFIN_API_URL` | Rayfin backend URL | `http://localhost:5168` |
| `RAYFIN_PUBLIC_PUBLISHABLE_KEY` | `VITE_RAYFIN_PUBLISHABLE_KEY` | Rayfin publishable key | (generated on dev) |
| `RAYFIN_PUBLIC_ITEM_ID` | `VITE_FABRIC_ITEM_ID` | Fabric item/project ID (written by `rayfin up`) | -- |
| `RAYFIN_PUBLIC_WORKSPACE_ID` | `VITE_FABRIC_WORKSPACE_ID` | Fabric workspace ID for auth | -- |
| `RAYFIN_PUBLIC_PORTAL_URL` | `VITE_FABRIC_PORTAL_URL` | Fabric portal URL for auth | -- |

Deployment metadata (including hosting URL) is stored in `rayfin/.deployments.json`.
Use `rayfin up list` to view all deployments.

## Next Steps

For a more advanced example with categories, relationships, profile images, and dual mock/Rayfin service modes, see the [todo-app](../todo-app/) sample.

## License

See the [LICENSE](LICENSE) file for details.
