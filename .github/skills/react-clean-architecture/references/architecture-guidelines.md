# React Clean Architecture — Full Reference

Comprehensive architectural guidelines for scalable React applications in enterprise systems.

## Component-Centric Design

### Single Responsibility Principle (SRP)

A component should do one thing and do it well. Split between:

- **UI components** — focused on rendering JSX from props
- **Logic hooks** — encapsulate state, effects, and business rules

A component exceeding 200 lines is statistically handling multiple concerns. Decompose immediately.

**Why SRP matters:**

- **Testability** — smaller components allow precise unit testing without mocking complex dependencies
- **Reconciliation performance** — React's virtual DOM operates more efficiently on small component trees
- **Cognitive load** — developers reason about a 50-line component faster than a 500-line one

### Lifting Content Up, Pushing State Down

**Lifting content up:** Move the rendering of child components to a parent, then pass them down as props (slots). This prevents unnecessary re-renders when the parent's state changes because React sees the same JSX reference.

**Pushing state down:** Move state as close as possible to the components that consume it. When state lives too high in the tree, every update triggers reconciliation for the entire sub-tree, even components that don't use the data.

## Directory Organization

### Page-Centric Colocation

Traditional structures organized by file type (`/components`, `/hooks`, `/services`) fail at scale because they force developers to jump across directories for a single logical change.

```
src/pages/[PageName]/
├── index.tsx              # Page component (route entry point)
├── components/            # UI specific to this page
│   ├── login-form.tsx
│   └── header.tsx
├── hooks/                 # Logic specific to this page
│   ├── use-page-data.ts
│   └── use-auth-form.ts
├── services/              # Data fetching for this page
│   ├── api.ts
│   └── transformers.ts
└── types/                 # TS definitions for this page
    ├── interfaces.ts
    └── enums.ts
```

Code starts local. Only becomes global when reuse is **proven** by three or more consumers.

### Feature-Sliced Design (FSD)

For enterprise applications, FSD provides strict vertical layers and horizontal business slices:

```
app/          → Application-wide setup (providers, routing, global styles)
pages/        → Route-level compositions
widgets/      → Large self-contained UI blocks (sidebar, header)
features/     → User interactions (add-to-cart, login, search)
entities/     → Business objects (product, user, order)
shared/       → Reusable infrastructure (UI kit, API client, utilities)
```

**Strict rule:** A layer may only depend on layers **below** it. Features can import from Entities; Entities can never import from Features.

### Public API via Barrel Files

Each folder exposes an `index.ts` that exports only the public interface:

```typescript
// features/auth/index.ts
export { LoginForm } from './components/login-form';
export { useAuth } from './hooks/use-auth';
export type { AuthState } from './types';
```

Internal refactoring never breaks external consumers.

## Composition Patterns

### The Children Prop and Slots

Using `children` allows a component to act as a layout shell without knowing the specifics of its content:

```tsx
interface LayoutProps {
  header: React.ReactNode;
  sidebar: React.ReactNode;
  children: React.ReactNode;
}

function Layout({ header, sidebar, children }: LayoutProps) {
  return (
    <div className="layout">
      <header className="layout-header">{header}</header>
      <aside className="layout-sidebar">{sidebar}</aside>
      <main className="layout-content">{children}</main>
    </div>
  );
}
```

The parent (Page) passes fully-formed components into slots, avoiding configuration prop drilling through the Layout.

### Compound Components

Multiple components share state implicitly via Context API:

```tsx
// tabs.tsx
const TabsContext = createContext<TabsState | null>(null);

function Tabs({ children, defaultValue }: TabsProps) {
  const [active, setActive] = useState(defaultValue);
  return (
    <TabsContext.Provider value={{ active, setActive }}>
      <div role="tablist">{children}</div>
    </TabsContext.Provider>
  );
}

Tabs.Trigger = function Trigger({ value, children }: TriggerProps) {
  const { active, setActive } = useContext(TabsContext)!;
  return (
    <button
      role="tab"
      aria-selected={active === value}
      onClick={() => setActive(value)}
    >
      {children}
    </button>
  );
};

Tabs.Content = function Content({ value, children }: ContentProps) {
  const { active } = useContext(TabsContext)!;
  return active === value ? <div role="tabpanel">{children}</div> : null;
};
```

This produces readable, HTML-like APIs:

```tsx
<Tabs defaultValue="overview">
  <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
  <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
  <Tabs.Content value="overview">...</Tabs.Content>
  <Tabs.Content value="settings">...</Tabs.Content>
</Tabs>
```

## State Management

### State Categories

| Type | Tool | Scope |
|------|------|-------|
| **Local** | `useState`, `useReducer` | Component-specific UI toggles, input values |
| **Server** | TanStack Query (React Query) | Cached remote data with deduplication and sync |
| **Global UI** | Zustand, Redux Toolkit, Context | App-wide flags (sidebar open, active theme, modals) |
| **Persistent** | LocalStorage + custom hook | User preferences, auth tokens |

### Server State with TanStack Query

Use a **Query Key Factory** to centralize cache keys:

```typescript
// query-keys.ts
export const queryKeys = {
  todos: {
    all: ['todos'] as const,
    lists: () => [...queryKeys.todos.all, 'list'] as const,
    list: (filters: TodoFilters) =>
      [...queryKeys.todos.lists(), filters] as const,
    details: () => [...queryKeys.todos.all, 'detail'] as const,
    detail: (id: string) =>
      [...queryKeys.todos.details(), id] as const,
  },
};
```

This ensures consistent cache invalidation:

```typescript
// After creating a todo, invalidate the list cache
queryClient.invalidateQueries({ queryKey: queryKeys.todos.lists() });
```

### Context Splitting

Never create a single massive context for the entire application. Split by concern:

```typescript
// Separate providers, each wrapping only the sub-tree that needs them
<ThemeProvider>
  <AuthProvider>
    <App />
  </AuthProvider>
</ThemeProvider>
```

Each provider wraps as closely as possible to the consuming components.

## Custom Hooks

### Decoupling Business Logic from React

Write complex calculations as framework-agnostic TypeScript functions. The custom hook integrates them with the React lifecycle:

```typescript
// Pure business logic (independently testable)
function calculateDiscount(price: number, tier: CustomerTier): number {
  const rates: Record<CustomerTier, number> = {
    standard: 0,
    premium: 0.1,
    enterprise: 0.2,
  };
  return price * (1 - rates[tier]);
}

// React hook (bridges logic to component lifecycle)
function useDiscount(price: number, tier: CustomerTier) {
  return useMemo(() => calculateDiscount(price, tier), [price, tier]);
}
```

### Extract Repetitive Effects

Instead of each component handling an intersection observer inline, extract to a reusable hook:

```typescript
function useIntersectionObserver(
  ref: RefObject<HTMLElement>,
  options?: IntersectionObserverInit,
) {
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(([entry]) => {
      setIsIntersecting(entry.isIntersecting);
    }, options);

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, options]);

  return isIntersecting;
}
```

## TypeScript Governance

### Strict Mode Requirements

- Enable `strictNullChecks` and full `strict` mode
- Ban `any` — use `unknown` for external data
- Use utility types (`Pick`, `Omit`, `Partial`) to transform existing types rather than redefining

### Runtime Validation at Boundaries

Use Zod for API response validation:

```typescript
import { z } from 'zod';

const TodoSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  completed: z.boolean(),
  createdAt: z.string().datetime(),
});

type Todo = z.infer<typeof TodoSchema>;

// Validate at the boundary
async function fetchTodos(): Promise<Todo[]> {
  const response = await fetch('/api/todos');
  const data: unknown = await response.json();
  return z.array(TodoSchema).parse(data);
}
```

## Naming Conventions

### Event Handler Convention

| Context | Prefix | Example |
|---------|--------|---------|
| Internal implementation | `handle` | `handleSubmit`, `handleNameChange` |
| External prop interface | `on` | `onSave`, `onCancel`, `onChange` |

```tsx
// Internal: defines what happens
function Form({ onSubmit }: FormProps) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };
  return <form onSubmit={handleSubmit}>...</form>;
}
```

### File Naming

Use **kebab-case** for all files and directories:

- `user-profile-card.tsx` (not `UserProfileCard.tsx`)
- `use-auth-state.ts` (not `useAuthState.ts`)
- `query-keys.ts` (not `queryKeys.ts`)

This avoids case-sensitivity issues across macOS, Linux, and Windows.

### Import Strategy

Ban deep relative paths. Configure path aliases:

```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@/features/*": ["./src/features/*"],
      "@/shared/*": ["./src/shared/*"]
    }
  }
}
```

```typescript
// Clean
import { Button } from '@/shared/ui/button';

// Avoid
import { Button } from '../../../shared/ui/button';
```

## Testing Strategy

### Unit Tests (High Frequency)

Target pure functions, data transformers, and custom hooks:

```typescript
describe('calculateDiscount', () => {
  it('applies 20% for enterprise tier', () => {
    expect(calculateDiscount(100, 'enterprise')).toBe(80);
  });
});
```

### Integration Tests (Medium Frequency)

Test component + hook together, mimicking user interactions:

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

test('submits form with entered data', async () => {
  const onSubmit = vi.fn();
  render(<TodoForm onSubmit={onSubmit} />);

  await userEvent.type(screen.getByRole('textbox'), 'New task');
  await userEvent.click(screen.getByRole('button', { name: /add/i }));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'New task' }),
  );
});
```

### E2E Tests (Low Frequency)

Cover critical user journeys: authentication flows, checkout, data creation/deletion.

## Memoization Guidelines

Only memoize when there is a measurable benefit:

| Memoize When | Don't Memoize When |
|---|---|
| Value is a dependency of another hook | Value is a primitive (string, number, boolean) |
| Callback is passed to a `React.memo` child | Component has no memoized children |
| Expensive computation (measured, not assumed) | Simple object/array creation |

```typescript
// Justified: prevents re-renders in memoized child list
const sortedItems = useMemo(
  () => items.toSorted((a, b) => a.name.localeCompare(b.name)),
  [items],
);

// Unjustified: no memoized consumer
const label = useMemo(() => `Hello ${name}`, [name]); // Just use string interpolation
```
