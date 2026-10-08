# React Architecture Guidelines for Project Rayfin

This document describes the patterns, practices, and architectural decisions used in the React-based webviews of Project Rayfin.

## Overview

The webviews folder contains React-based UI components. Each view lives in its own folder under `src/webviews/` following the file organization pattern below.

Shared components live in `src/webviews/components/` (e.g. `MonacoEditor`, `Announcer`).

---

## Table of Contents

1. [Component Structure](#component-structure)
2. [State Management](#state-management)
3. [Styling Approach](#styling-approach)
4. [React Hooks Usage](#react-hooks-usage)
5. [Monaco Editor Integration](#monaco-editor-integration)
6. [Third-Party Component Integration](#third-party-component-integration)
7. [Common Patterns](#common-patterns)
8. [Known Issues & Anti-Patterns](#known-issues--anti-patterns)

---

## Component Structure

### File Organization

Each view follows a consistent structure:

```
viewName/
├── viewName.tsx           # Main component
├── viewName.scss          # View-specific styles
├── viewNameContext.ts     # Context and state types (if complex)
├── viewNameController.ts  # Backend communication logic (WebviewController subclass)
├── viewNameRouter.ts      # tRPC router with server-side procedures
├── constants.ts           # View-specific constants
├── components/            # Sub-components
│   ├── Component.tsx
│   ├── component.scss     # Component-specific styles (if needed)
│   ├── toolbar/           # Toolbar components
│   └── queryEditor/       # Feature-specific component groups
├── hooks/                 # Custom React hooks
│   └── useCustomHook.ts
├── types/                 # TypeScript type definitions
│   └── featureTypes.ts
└── utils/                 # Utility functions
    └── helper.ts
```

### Component Hierarchy Example

Example component hierarchy for a typical view:

```tsx
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

---

## State Management

### Local State with `useState`

Used for simple, component-local state:

```tsx
const [isLoading, setIsLoading] = useState(false);
const [isDirty, setIsDirty] = useState(true);
const [editorContent, setEditorContent] = useState('{ }');
```

### Context API for Shared State

For complex views with cross-component state, use React Context with a `[state, setState]` tuple:

```tsx
// Define context type
export type MyViewContextType = {
  isLoading: boolean;
  activeData: Record<string, unknown>;
};

// Create context with tuple pattern [state, setState]
export const MyViewContext = createContext<
  [MyViewContextType, React.Dispatch<React.SetStateAction<MyViewContextType>>]
>([DefaultMyViewContext, () => {}]);

// Usage in parent component
const [currentContext, setCurrentContext] = useState<MyViewContextType>(DefaultMyViewContext);

return <MyViewContext.Provider value={[currentContext, setCurrentContext]}>{/* children */}</MyViewContext.Provider>;

// Usage in child component
const [currentContext, setCurrentContext] = useContext(MyViewContext);
```

Simple views can use local `useState` + props without context.

### State Updates

Always use functional updates when new state depends on previous state:

```tsx
setCurrentContext((prev) => ({
  ...prev,
  isLoading: true,
  activeQuery: {
    ...prev.activeQuery,
    pageNumber: 1,
  },
}));
```

---

## Styling Approach

### SCSS Files

Each component can have its own `.scss` file. Styles are imported directly in the component:

```tsx
import './myView.scss';
```

### Shared Styles

Common styles can be placed in a shared SCSS file and imported:

```scss
// Example shared styles
@use '../index.scss';

$media-breakpoint-query-control-area: 1024px;
```

Use `@extend` to apply shared styles:

```scss
.myView {
  @extend .selectionDisabled;
  // ... other styles
}
```

### Spacing and Layout Patterns

**Consistent spacing unit: `10px`**

#### Flexbox Layouts with Gaps

```scss
.myView {
  display: flex;
  flex-direction: column;
  height: 100vh;
  row-gap: 10px; // Consistent 10px spacing between flex children
}
```

#### Padding Patterns

```scss
.toolbarContainer {
  padding-top: 10px; // Top padding for toolbars
}

.monacoAutoHeightContainer {
  padding-top: 6px;
  padding-bottom: 6px;
  padding-right: 4px;
}
```

#### Flexbox Sizing

```scss
.monacoContainer {
  flex-grow: 1; // Take available space
  flex-shrink: 1; // Allow shrinking
  flex-basis: 0%; // Start from 0 and grow
}

.toolbarContainer {
  flex-grow: 0; // Don't grow
  flex-shrink: 1; // Allow shrinking
  flex-basis: auto; // Use content size
}
```

#### Negative Margins (Use with Caution)

```scss
.toolbarTableNavigation {
  margin-top: -10px; // Pull element up to reduce spacing
}
```

**⚠️ WARNING**: Negative margins can cause layout issues and should be used sparingly. Consider if the layout can be achieved with proper flexbox/gap instead.

#### Inline Styles (Avoid When Possible)

Some inline styles are used in components:

```tsx
<TabList selectedValue="tab_result" style={{ marginTop: '-10px' }}>
```

**🔴 ISSUE**: Inline styles should be moved to SCSS files for consistency and maintainability.

---

## React Hooks Usage

### `useEffect` - Component Lifecycle

#### Run Once on Mount (Empty Dependency Array)

```tsx
useEffect(() => {
  if (configuration.mode !== 'add') {
    const documentId: string = configuration.documentId;

    setIsLoading(true);

    void trpcClient.myView.getData
      .query()
      .then((response) => {
        setContent(response);
      })
      .catch((error) => {
        void trpcClient.common.displayErrorMessage.mutate({
          message: l10n.t('Error while loading the document'),
          modal: false,
          cause: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsLoading(false);
      });
  }
}, []); // Empty array = run once on mount
```

#### Run on Specific State Changes

```tsx
useEffect(() => {
  // Update query editor context whenever filter value changes
  setCurrentContext((prev) => ({
    ...prev,
    queryEditor: prev.queryEditor
      ? {
          ...prev.queryEditor,
          getCurrentQuery: () => ({
            filter: filterValue,
            project: projectValue,
            sort: sortValue,
            skip: skipValue,
            limit: limitValue,
          }),
        }
      : prev.queryEditor,
  }));
}, [filterValue, projectValue, sortValue, skipValue, limitValue, setCurrentContext]); // Re-run when these change
```

#### Cleanup Pattern

```tsx
useEffect(() => {
  const debouncedResizeHandler = debounce(handleResize, 200);
  window.addEventListener('resize', debouncedResizeHandler);

  // Cleanup function
  return () => {
    if (editorRef.current) {
      editorRef.current.dispose();
    }
    window.removeEventListener('resize', debouncedResizeHandler);
  };
}, []);
```

### `useRef` - Storing Mutable References

#### Storing DOM/Component References

```tsx
const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);

// Set ref when component mounts
const handleMonacoEditorMount = (editor: monacoEditor.editor.IStandaloneCodeEditor) => {
  editorRef.current = editor;
};

// Access later without causing re-renders
const getCurrentContent = () => editorRef.current?.getValue() || '';
```

**Example from QueryEditor** - storing query state in context:

```tsx
const getCurrentQueryFunction = () => ({
  filter: filterValue,
  project: projectValue,
  sort: sortValue,
  skip: skipValue,
  limit: limitValue,
});

setCurrentContext((prev) => ({
  ...prev,
  queryEditor: {
    getCurrentQuery: getCurrentQueryFunction,
    setJsonSchema: async (schema) => {
      /* ... */
    },
  },
}));
```

#### Solving Stale Closure Issues

**🚨 CRITICAL PATTERN**: When using third-party components that don't automatically update event handlers on re-renders:

```tsx
// Problem: Event handlers capture state at initialization time
// Solution: Store latest state in refs

const [currentQueryResults, setCurrentQueryResults] = useState<QueryResults>();
const currentQueryResultsRef = useRef(currentQueryResults);

// Keep ref in sync with state
useEffect(() => {
  currentQueryResultsRef.current = currentQueryResults;
}, [currentQueryResults]);

// In event handler, use ref to get latest data
const onCellDblClick = useCallback((event: CustomEvent) => {
  // ✅ Good: Access latest data via ref
  const activeDocument = currentQueryResultsRef.current?.tableData?.[row];

  // ❌ Bad: Would capture stale state
  // const activeDocument = currentQueryResults?.tableData?.[row];
}, []);
```

**Why this is needed:**

```tsx
// Third-party components may bind event handlers during initialization:
// 1. Component initializes with state = { data: [...] }
// 2. Event handler is created and captures state
// 3. State updates to { data: [...new items...] }
// 4. Event handler STILL sees old state (stale closure)
// 5. Using ref solves this because ref.current is always the latest value
```

### `useCallback` - Memoized Callbacks

Use `useCallback` for event handlers passed to child components or third-party libraries:

```tsx
const handleViewChanged = useCallback((optionValue: string) => {
  setCurrentContext((prev) => ({ ...prev, currentView: selection }));
  getDataForView(selection);
}, []); // Dependencies array
```

**Note**: When combined with the ref pattern, dependencies should only include stable references:

```tsx
const onSelectedRowsChanged = useCallback(
  (_eventData: unknown, _args: OnSelectedRowsChangedEventArgs): void => {
    setCurrentContext((prev) => ({
      ...prev,
      dataSelection: {
        selectedDocumentIndexes: _args.rows,
        // Use ref for latest data, not the prop
        selectedDocumentObjectIds: _args.rows.map((row) => liveDataRef.current[row]?.['x-objectid'] ?? ''),
      },
    }));
  },
  [setCurrentContext], // Only setCurrentContext, NOT liveData
);
```

---

## Monaco Editor Integration

### Basic Monaco Editor Setup

The project wraps Monaco Editor in a custom component:

```tsx
import { MonacoEditor } from '../../MonacoEditor';

<MonacoEditor
  height={'100%'}
  width={'100%'}
  language="json"
  options={monacoOptions}
  value={editorContent}
  onMount={handleMonacoEditorMount}
  onChange={() => setIsDirty(true)}
/>;
```

### Monaco Options

```tsx
const monacoOptions = {
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  readOnly: false,
  automaticLayout: false, // Handle manually for performance
};
```

### Manual Layout Updates

Monaco needs manual layout updates when container size changes:

```tsx
const handleResize = () => {
  if (editorRef.current) {
    editorRef.current.layout();
  }
};

useEffect(() => {
  const debouncedResizeHandler = debounce(handleResize, 200);
  window.addEventListener('resize', debouncedResizeHandler);
  handleResize(); // Initial layout

  return () => {
    window.removeEventListener('resize', debouncedResizeHandler);
  };
}, []);
```

### Auto Height Monaco Editor

The `MonacoAutoHeight` component extends Monaco with dynamic height based on content:

```tsx
<MonacoAutoHeight
  height={'100%'}
  width={'100%'}
  language="json"
  adaptiveHeight={{
    enabled: true,
    maxLines: 10,
    minLines: 1,
    lineHeight: 19,
  }}
  onExecuteRequest={() => {
    onExecuteRequest();
  }}
  onMount={(editor, monaco) => {
    handleEditorDidMount(editor, monaco);
  }}
  options={monacoOptions}
/>
```

**Features:**

- Adjusts height based on line count (between minLines and maxLines)
- Registers Ctrl/Cmd+Enter shortcut via `onExecuteRequest`
- Uses ref pattern to avoid stale closures

### JSON Schema Integration

Set JSON schema for autocompletion and validation:

```tsx
monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  schemas: [
    {
      uri: 'json-schema.json',
      fileMatch: ['*'],
      schema: basicFindQuerySchema,
    },
  ],
});
```

**⚠️ Known Issue**: Monaco's JSON worker may not be initialized immediately after mount. Use a delay:

```tsx
await new Promise((resolve) => setTimeout(resolve, 2000));
monaco.languages.json.jsonDefaults.setDiagnosticsOptions({...});
```

**🔴 TODO**: Implement proper worker initialization check instead of hardcoded delay.

---

## Third-Party Component Integration

---

## Common Patterns

### Loading State Management

```tsx
const [isLoading, setIsLoading] = useState(false);

// Before async operation
setIsLoading(true);

try {
  await someAsyncOperation();
} finally {
  setIsLoading(false); // Always reset in finally
}

// In render
{
  isLoading && <ProgressBar thickness="large" shape="square" className="progressBar" />;
}
```

### Progress Bar Positioning

```tsx
// In component
{isLoading && <ProgressBar className="progressBar" />}

// In SCSS
.progressBar {
    position: absolute;
    left: 0px;
    top: 0px;
}
```

### Conditional Rendering Patterns

**Object-based switch statement:**

```tsx
{
    {
        'Table View': <DataViewPanelTable {...props} />,
        'Tree View': <DataViewPanelTree {...props} />,
        'JSON View': <DataViewPanelJSON {...props} />,
        default: <div>error '{currentContext.currentView}'</div>,
    }[currentContext.currentView]
}
```

**Conditional component rendering:**

```tsx
{
  currentContext.currentView === Views.TABLE && (
    <div className="toolbarTableNavigation">
      <ToolbarTableNavigation />
    </div>
  );
}
```

### Debouncing

Use `es-toolkit` for debouncing:

```tsx
import { debounce } from 'es-toolkit';

const debouncedResizeHandler = debounce(handleResize, 200);
```

### Error Handling

```tsx
try {
  const result = await trpcClient.someOperation.query();
} catch (error) {
  void trpcClient.common.displayErrorMessage.mutate({
    message: l10n.t('Error message'),
    modal: false, // or true for important errors
    cause: error instanceof Error ? error.message : String(error),
  });
}
```

### Telemetry/Event Reporting

```tsx
trpcClient.common.reportEvent
  .mutate({
    eventName: 'executeQuery',
    properties: {
      ui: 'button',
    },
    measurements: {
      queryLength: q.length,
    },
  })
  .catch((error) => {
    console.debug('Failed to report an event:', error);
  });
```

---

## Rendering Architecture

### Entry Point

The webview rendering pipeline starts in `index.tsx`:

```tsx
import { WebviewRegistry } from './api/configuration/WebviewRegistry';
import { DynamicThemeProvider } from './theme/DynamicThemeProvider';
import { WithWebviewContext } from './WebviewContext';

export function render<V extends ViewKey>(key: V, vscodeApi: WebviewApi<WebviewState>, rootId = 'root'): void {
  l10n.config({ contents: (globalThis.l10n_bundle as l10nJsonFormat) ?? {} });
  const container = document.getElementById(rootId);
  const Component: React.ComponentType = WebviewRegistry[key];
  const root = createRoot(container);

  root.render(
    <DynamicThemeProvider useAdaptive={true}>
      <WithWebviewContext vscodeApi={vscodeApi}>
        <Component />
      </WithWebviewContext>
    </DynamicThemeProvider>,
  );
}
```

**Key architecture layers:**

- **`DynamicThemeProvider`**: Adapts Fluent UI theming to VS Code's current color theme
- **`WithWebviewContext`**: Provides `vscodeApi` (for postMessage) via React Context
- **`WebviewRegistry`**: Maps webview names to React components
- **`l10n` config**: Loads localization bundle injected by the extension host

### Configuration Flow

1. Extension host creates `WebviewController` with a configuration object
2. Configuration is serialized as `encodeURIComponent(JSON.stringify(config))` in the HTML template
3. Webview reads it via `useConfiguration<T>()` hook:

```tsx
export function useConfiguration<T>(): T {
  const [configuration] = useState<T>(() => {
    const configString = decodeURIComponent(window.config?.__initialData ?? '{}');
    return JSON.parse(configString) as T;
  });
  return configuration;
}
```

---

## AbortController, tRPC, and Accessibility

These topics are covered by dedicated skills. See:

- **AbortSignal & tRPC messaging**: `.github/skills/vscode-webview-trpc-messaging/SKILL.md`

For accessibility, use the `Announcer` component from `src/webviews/components/Announcer.tsx` for screen reader announcements.

---

## Fluent UI Integration

The webviews use `@fluentui/react-components` (Fluent UI v9) as the primary component library, themed to match VS Code via `DynamicThemeProvider`.

### Common Components

| Component                      | Usage                                     |
| ------------------------------ | ----------------------------------------- |
| `ProgressBar`                  | Loading indicators                        |
| `Button`, `ToggleButton`       | Toolbar actions                           |
| `Tab`, `TabList`               | View switching (Results / Query Insights) |
| `Dropdown`, `Option`           | Selection controls (ViewSwitcher)         |
| `Badge`                        | Status/preview indicators                 |
| `Input`, `Label`               | Form fields                               |
| `Tooltip`                      | Hover help text                           |
| `MessageBar`, `MessageBarBody` | Info/warning messages                     |
| `Skeleton`, `SkeletonItem`     | Loading placeholders                      |
| `Text`                         | Typography                                |

### Animations

Use `@fluentui/react-motion-components-preview` for collapse/expand animations:

```tsx
import { Collapse } from '@fluentui/react-motion-components-preview';

<Collapse visible={isExpanded}>
  <div>{/* collapsible content */}</div>
</Collapse>;
```

---

## Custom Hooks

### `useConfiguration<T>`

Reads the initial configuration object passed to the webview at creation:

```tsx
const configuration = useConfiguration<MyViewConfig>();
```

### `useSelectiveContextMenuPrevention`

Prevents browser context menus everywhere except Monaco editors. Call once in the top-level view component.

For tRPC-related hooks (`useTrpcClient`) and patterns, see the **vscode-webview-trpc-messaging** skill.

---

## Known Issues & Anti-Patterns

### 🔴 Issues to Fix

1. **Inline Styles**: Some components use inline styles instead of SCSS

   ```tsx
   // ❌ Bad - should be in SCSS
   <TabList style={{ marginTop: '-10px' }}>
   ```

2. **Negative Margins**: Overused to fix spacing issues

   ```scss
   // ⚠️ Use sparingly, indicates potential layout issue
   margin-top: -10px;
   ```

3. **Monaco Worker Initialization**: Hardcoded 2-second delay

   ```tsx
   // 🔴 TODO: Replace with proper worker ready check
   await new Promise((resolve) => setTimeout(resolve, 2000));
   ```

4. **Component Organization**: Keep view-specific files together in the view folder
   - Follow the file organization pattern from the Component Structure section
   - Follow the file organization pattern from the Component Structure section above

### ⚠️ Common Pitfalls

1. **Forgetting to use refs with third-party components**

   ```tsx
   // ❌ Will capture stale state
   const onClick = () => {
     console.log(someState);
   };

   // ✅ Use ref pattern
   const stateRef = useRef(someState);
   useEffect(() => {
     stateRef.current = someState;
   }, [someState]);
   const onClick = () => {
     console.log(stateRef.current);
   };
   ```

2. **Not cleaning up event listeners**

   ```tsx
   // ✅ Always clean up
   useEffect(() => {
     window.addEventListener('resize', handler);
     return () => window.removeEventListener('resize', handler);
   }, []);
   ```

3. **Forgetting Monaco manual layout**

   ```tsx
   // ✅ Always call layout() after resize or mount
   editorRef.current?.layout();
   ```

4. **Using `any` in TypeScript**
   - Follow project guidelines: Never use `any`
   - Use proper types or `unknown` with type guards

5. **Not using localization**

   ```tsx
   // ❌ Bad
   <button>Save</button>

   // ✅ Good
   <button>{l10n.t('Save')}</button>
   ```

### 🟡 Design Decisions to Review

1. **Context Pattern**: Complex views may use context extensively while simple views use local state
   - **Consider**: Is context needed? Could it be simplified?
   - **Benefit**: Reduces prop drilling
   - **Drawback**: Makes data flow harder to trace

2. **Component Splitting**: Some components are very large (400+ lines)
   - **Consider**: Breaking down into smaller, focused components
   - Follow the file organization pattern from Component Structure above

3. **State Duplication**: Avoid duplicating data between context and local state
   ```tsx
   // Keep state in one place — either context or local, not both
   ```

---

## Summary of Best Practices

### ✅ Do's

- Use consistent 10px spacing units
- Use flexbox with `row-gap`/`column-gap` for spacing
- Store third-party component references in `useRef`
- Use ref pattern to solve stale closure issues
- Clean up event listeners, subscriptions, and AbortControllers
- Use functional state updates when depending on previous state
- Always localize user-facing strings with `l10n.t()`
- Define styles in SCSS files, not inline
- Use `es-toolkit` for utilities like `debounce`
- Handle errors gracefully with user-friendly messages
- Use Monaco's manual layout for performance
- Use Fluent UI components themed via `DynamicThemeProvider`

### ❌ Don'ts

- Don't use inline styles (move to SCSS)
- Don't overuse negative margins (fix layout instead)
- Don't forget to clean up in useEffect return (listeners, AbortControllers)
- Don't use `any` type (use proper types or `unknown`)
- Don't capture state in closures for third-party components (use refs)
- Don't hardcode delays (use proper initialization checks)
- Don't forget to call `editor.layout()` after resize
- Don't mix state management patterns inconsistently

---

## References

- TypeScript Guidelines: See `AGENTS.md`
- tRPC Messaging: See `.github/skills/vscode-webview-trpc-messaging/SKILL.md`
- VS Code Webview API: [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- Monaco Editor API: [Monaco Editor API](https://microsoft.github.io/monaco-editor/api/index.html)
- React Hooks: [React Hooks Reference](https://react.dev/reference/react)

---

_Document Version: 3.0_
_Last Updated: February 13, 2026_
_Based on: Project Rayfin architecture_
