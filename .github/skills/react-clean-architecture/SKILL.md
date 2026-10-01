---
name: react-clean-architecture
description: 'Architectural principles for scalable, maintainable React applications. Use when designing component hierarchies, organizing directories, choosing state management patterns, decomposing large components, applying composition patterns (slots, compound components), enforcing colocation, creating custom hooks, setting up Feature-Sliced Design layers, reviewing component structure, or refactoring React code for cleanliness. Covers SRP, the 200-line rule, prop drilling avoidance, server state with TanStack Query, naming conventions (handle/on), and strict TypeScript governance.'
---

# React Clean Architecture

Principles and rules for building scalable, maintainable React codebases in enterprise systems.

**Full reference**: See [references/architecture-guidelines.md](./references/architecture-guidelines.md)

## When to Use

- Designing or reviewing component hierarchies
- Organizing directories for a new feature or page
- Decomposing a large component (the 200-line rule)
- Choosing between local, global, and server state
- Applying composition patterns (slots, compound components, children)
- Creating custom hooks to extract logic from components
- Enforcing colocation and Feature-Sliced Design boundaries
- Reviewing naming conventions and import strategies
- Setting up testing strategy for React features

## Constitutional Rules

These 15 rules are non-negotiable in large-scale React projects.

### 1. Domain-Driven Colocation

Keep all code specific to a page or feature (components, hooks, tests, styles) in that page's folder.
Only promote code to global/shared folders when it is used by **three or more** distinct domains.

### 2. Strict Layered Dependencies

Follow the FSD hierarchy: `App > Pages > Widgets > Features > Entities > Shared`.
A module may only import from a **lower** layer. Never allow upward or circular imports.

### 3. Public API Encapsulation

Each folder must expose a public API via an `index.ts` file.
External modules must only import from this file, never from the folder's internal files.

### 4. Single Responsibility Hooks

Extract all stateful logic and side effects from components into custom hooks.
A component's primary job is to map data to JSX; the hook's job is to manage the data.

### 5. The 200-Line Threshold

Components exceeding 200 lines are architectural failures.
Decompose them into smaller sub-components or extract logic to hooks immediately.

### 6. Composition Over Prop Drilling

Use the `children` prop and named slots for layouts.
If you find yourself passing a prop through more than two levels, use composition or a dedicated context.

### 7. Absolute Import Aliases

Ban deep relative paths. Use `@/` aliases (e.g., `@/features/auth`) to ensure imports are location-independent and easy to refactor.

### 8. Strict Type Governance

Use TypeScript in strict mode. Ban `any`. Use `unknown` for external data and validate it at the boundary using Zod or equivalent runtime checkers.

### 9. Unified Server State

Use TanStack Query for all remote data. Implement a **Query Key Factory** to prevent hardcoded strings and ensure consistent cache invalidation.

### 10. Handler vs Prop Naming

Prefix internal event functions with `handle` (e.g., `handleReset`).
Prefix external event props with `on` (e.g., `onReset`).

### 11. Reference Stability

Memoize callbacks and values (`useCallback`, `useMemo`) only when they are dependencies for other hooks or props for memoized components to prevent render cascades.

### 12. Kebab-Case File Standards

Use kebab-case for all files and directories (e.g., `user-profile.tsx`).
This ensures cross-platform compatibility and avoids case-sensitivity bugs.

### 13. Semantic HTML and A11y

Prioritize semantic tags (`button`, `nav`, `section`) over generic `div` tags.
Use automated accessibility linters to enforce ARIA standards in every PR.

### 14. Behavior-Driven Testing

Write integration tests that mimic user interactions using React Testing Library.
Do not test internal component state or private methods.

### 15. Proactive State Colocation

Keep state as low as possible. Do not "lift state up" to a global provider if only a small sub-tree needs it.
Use "Push State Down" to minimize re-render impacts.

## Quick Decision Tables

### Component Health Check

| Attribute | Clean | Anti-Pattern |
|-----------|-------|--------------|
| Length | < 200 lines | 500+ lines ("God Component") |
| Logic | Extracted into custom hooks | Inline `useEffect`/`useState` storms |
| Props | Specific, typed, minimal | Large untyped objects, prop drilling |
| Rendering | Declarative, focused | Nested ternaries, inline mapping chains |
| Styling | Colocated CSS modules or utility classes | Massive global stylesheets or inline styles |

### State Type Selection

| State Type | Tool | Purpose |
|------------|------|---------|
| Local | `useState`, `useReducer` | UI toggles, input values |
| Server | TanStack Query, SWR | Caching and fetching remote data |
| Global UI | Zustand, Redux Toolkit | App-wide flags (sidebars, themes, modals) |
| Persistent | LocalStorage + custom hook | User preferences, auth tokens |

### Testing Pyramid

| Level | Frequency | Tool | Target |
|-------|-----------|------|--------|
| Unit | High | Vitest/Jest | Utilities, hooks, reducers |
| Integration | Medium | React Testing Library | Feature modules, pages |
| E2E | Low | Cypress/Playwright | Critical user journeys |

## Procedures

### Decomposing a Large Component

1. Identify concerns: data fetching, event handling, rendering sections
2. Extract stateful logic into a `useFeatureName` custom hook
3. Split rendering into sub-components (each < 200 lines)
4. Connect via props or composition (children/slots)
5. Create `index.ts` barrel exporting only the public API

### Organizing a New Feature Directory

```
feature-name/
├── index.ts              # Public API (barrel)
├── feature-name.tsx      # Main component
├── feature-name.test.tsx # Integration test
├── components/           # Sub-components
├── hooks/                # Custom hooks
├── types/                # TypeScript types
├── utils/                # Pure helper functions
└── constants.ts          # Feature-specific constants
```

### Promoting Shared Code

1. Code starts **local** to its feature/page
2. When a second consumer appears, consider if duplication is acceptable
3. When **three or more** consumers exist, promote to `shared/` or `entities/`
4. Update the barrel `index.ts` in the target directory
5. Update all imports to use the new shared path

### Applying Composition Patterns

**Slots pattern** — when a layout needs pluggable sections:

```tsx
function Layout({ header, sidebar, content }: LayoutProps) {
  return (
    <div>
      <header>{header}</header>
      <aside>{sidebar}</aside>
      <main>{content}</main>
    </div>
  );
}
```

**Compound components** — when sub-components share implicit state:

```tsx
<Tabs>
  <Tabs.List>
    <Tabs.Trigger value="a">Tab A</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="a">Content A</Tabs.Content>
</Tabs>
```
