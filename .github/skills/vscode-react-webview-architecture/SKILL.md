---
name: vscode-react-webview-architecture
description: Architecture patterns for React-based webviews in the Rayfin VS Code extension (packages/tools/vscode). Use when creating new webview components, working with state management (Context API), integrating Fluent UI components, solving stale closure bugs with refs, or debugging webview rendering issues. Does NOT cover tRPC messaging (see vscode-webview-trpc-messaging skill).
---

# React Webview Architecture

Patterns and conventions for React webviews in Project Rayfin.

**Related skills** (do not duplicate):

- **vscode-webview-trpc-messaging** — tRPC routers, procedures, telemetry, AbortSignal, subscriptions, WebviewController

**Full reference**: See [references/REACT_ARCHITECTURE_GUIDELINES.md](./references/REACT_ARCHITECTURE_GUIDELINES.md)

## When to Use

- Creating or modifying a webview
- Adding new components inside `packages/tools/vscode/src/webviews/`
- Working with React Context state management
- Integrating Monaco Editor
- Debugging stale closure issues in event handlers

## Rendering Pipeline

Every webview boots through `packages/tools/vscode/src/webviews/index.tsx`:

```tsx
root.render(
  <DynamicThemeProvider useAdaptive={true}>
    <WithWebviewContext vscodeApi={vscodeApi}>
      <Component />
    </WithWebviewContext>
  </DynamicThemeProvider>,
);
```

- **`DynamicThemeProvider`** — adapts Fluent UI theming to VS Code's active color theme
- **`WithWebviewContext`** — provides `vscodeApi` (postMessage) via React Context
- **`WebviewRegistry`** — maps webview names → React components (in `packages/tools/vscode/src/webviews/api/configuration/WebviewRegistry.ts`)

Configuration from the extension host is read via `useConfiguration<T>()`.

## File Organization

```
viewName/
├── ViewName.tsx            # Main component
├── viewName.scss           # Styles
├── viewNameContext.ts      # Context + state types (if complex)
├── viewNameController.ts   # WebviewController subclass (extension-side)
├── viewNameRouter.ts       # tRPC router (extension-side, see vscode-webview-trpc-messaging skill)
├── constants.ts
├── components/             # Sub-components
├── hooks/                  # Custom React hooks
├── types/                  # TypeScript types
└── utils/                  # Helpers
```

## Component Hierarchy

Example component hierarchy for a typical view:

```
MyView
├── Header
├── ToolbarActions
├── TabList
│   ├── ContentTab
│   │   └── ContentPanel
│   └── EditorTab
│       └── MonacoEditor
└── StatusBar
```

## State Management

### Simple views: local `useState` + props

### Complex views: React Context with `[state, setState]` tuple

```tsx
export const MyViewContext = createContext<
    [MyViewContextType, React.Dispatch<React.SetStateAction<MyViewContextType>>]
>([DefaultMyViewContext, () => {}]);

// Provider in parent
const [currentContext, setCurrentContext] = useState(DefaultMyViewContext);
<MyViewContext.Provider value={[currentContext, setCurrentContext]}>

// Consumer in child
const [currentContext, setCurrentContext] = useContext(MyViewContext);
```

**Always use functional updates** when state depends on previous value:

```tsx
setCurrentContext((prev) => ({
  ...prev,
  isLoading: true,
  activeQuery: { ...prev.activeQuery, pageNumber: 1 },
}));
```

## Stale Closure Pattern (CRITICAL)

Third-party components that bind event handlers at initialization don't update when state changes. **Always use refs** to access current data in those handlers:

```tsx
const dataRef = useRef(data);
useEffect(() => {
  dataRef.current = data;
}, [data]);

const onClick = useCallback((event) => {
  const item = dataRef.current[event.detail.args.row]; // ✅ always current
  // NOT: data[event.detail.args.row]; ❌ stale closure
}, []); // stable deps only
```

**Why**: Some third-party components bind handlers once at init time. Without refs, handlers see the data from initialization, not the latest state.

## Fluent UI Integration

Use `@fluentui/react-components` (v9), themed via `DynamicThemeProvider`:

| Component                  | Usage                     |
| -------------------------- | ------------------------- |
| `ProgressBar`              | Loading states            |
| `Button`, `ToggleButton`   | Toolbar actions           |
| `Tab`, `TabList`           | View switching            |
| `Dropdown`, `Option`       | Selection (ViewSwitcher)  |
| `Badge`                    | Status/preview indicators |
| `MessageBar`               | Info/warning messages     |
| `Skeleton`, `SkeletonItem` | Loading placeholders      |

## Styling

- Each component gets its own `.scss` file, imported directly
- Shared styles in `sharedStyles.scss`, applied via `@extend`
- **Consistent spacing unit: `10px`** with flexbox `row-gap`/`column-gap`
- **No inline styles** — move to SCSS files
- Avoid negative margins — fix layout with proper flexbox

```scss
.myView {
  display: flex;
  flex-direction: column;
  height: 100vh;
  row-gap: 10px;
}
```

## Custom Hooks

| Hook                                  | Location                                                      | Purpose                                                                                      |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `useSelectiveContextMenuPrevention()` | `packages/tools/vscode/src/webviews/api/webview-client/utils/` | Prevents browser context menu everywhere except Monaco editors. Call once in top-level view. |

## Conditional Rendering Patterns

**Object-based switch:**
