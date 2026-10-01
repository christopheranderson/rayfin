# rayfin-vscode — VS Code Extension

VS Code extension for Project Rayfin development, built inside the Rush monorepo.

## Build Commands

| Command | Purpose |
| --- | --- |
| `rush build --to rayfin-vscode` | Build extension and its dependencies |
| `rushx build:dev` | Development build (from project directory) |
| `rushx build` | Production build |
| `rushx build:watch` | Watch mode — rebuilds all bundles on save |
| `rushx typecheck` | Type-check without emitting |
| `rushx test` | Run tests with Vitest |
| `rushx l10n` | Regenerate localization bundle |
| `rushx l10n:check` | Verify localization bundle is up to date |
| `rushx package` | Package the `.vsix` extension |

## Subspace

This project is in the `vscode` Rush subspace.

```bash
rush update --subspace vscode
```

## Tooling

- **Bundler**: esbuild (not webpack) — see `esbuild.mjs`
- **Test framework**: Vitest (not Jest) — run `rushx test`
- **Three bundles**: desktop (`dist/main.js`), web (`dist/web/extension.js`), React webview (`dist/views.js` + `dist/views.css`)

## Source Structure

```text
src/
├── extension.ts              # Desktop extension entry point (activate/deactivate)
├── extensionVariables.ts     # Shared ext namespace (context, outputChannel)
├── commands/                 # Command implementations (signIn, up, upTool)
├── services/                 # Service clients (fabric, rayfin, data)
├── utils/                    # Shared utilities (fs, openUrl)
├── web/
│   └── extension.ts          # Web extension entry point (re-exports shared code)
├── webviews/
│   ├── index.tsx             # Webview entry point — render() bootstraps React
│   ├── index.scss            # Global webview styles
│   ├── WebviewContext.tsx     # React Context providing vscodeApi (postMessage)
│   ├── typings.d.ts          # SCSS/CSS module declarations
│   ├── api/
│   │   ├── configuration/
│   │   │   ├── appRouter.ts      # Root tRPC router (commonRouter + view routers)
│   │   │   └── WebviewRegistry.ts # Maps webview names → React components
│   │   ├── extension-server/
│   │   │   ├── trpc.ts           # tRPC init, publicProcedure, telemetry middleware
│   │   │   └── WebviewController.ts # WebviewPanel lifecycle + tRPC message dispatcher
│   │   └── webview-client/
│   │       ├── useTrpcClient.ts  # React hook providing typed tRPC client
│   │       ├── useConfiguration.ts # Hook reading initial config from extension host
│   │       └── vscodeLink.ts     # Custom tRPC link over postMessage
│   ├── theme/                # Adaptive Fluent UI theming (color science pipeline)
│   └── mainView/             # Demo webview exercising all tRPC patterns
├── __mocks__/
│   └── vscode.js            # Vitest mock for the vscode module
└── __tests__/                # Extension tests
l10n/
├── bundle.l10n.json          # Generated localization bundle (do not edit manually)
└── scripts/                  # l10n build and check scripts
```

## Webview Architecture

React webviews communicate with the extension host via tRPC over postMessage. See these skills for details:

- `.github/skills/vscode-react-webview-architecture/` — component patterns, theming, state management
- `.github/skills/vscode-webview-trpc-messaging/` — routers, procedures, subscriptions, AbortSignal

To add a new webview: define a router, create a controller extending `WebviewController`, register in `appRouter` and `WebviewRegistry`, create a React component.

## React Skill Overrides

The `react-best-practices` and `react-clean-architecture` skills both apply to webview code.
Where they conflict, this project follows these decisions:

- **Barrel files (`index.ts`)**: Continue using barrel files for internal module boundaries per `react-clean-architecture` Rule 3.
  The `react-best-practices` `bundle-barrel-imports` rule targets massive external libraries (e.g., icon sets with thousands of re-exports).
  Internal barrels with small, curated export surfaces do not cause that problem, and esbuild resolves them at build time.
- **Server state library (SWR vs TanStack Query)**: Not applicable.
  This extension has no server state — webview data comes from the extension host via tRPC, not from HTTP endpoints.

## Guidelines

- Use `rush add -p <package>` for dependencies — never `npm`, `pnpm`, or `yarn` directly.
- Use `vscode.l10n.t()` for all user-facing strings.
- Run `rushx l10n` after changing user-facing strings; run `rushx l10n:check` to verify.
- Files under `src/webviews/` run in the browser (webview iframe), not Node.js.
- Files under `src/webviews/api/extension-server/` run in the extension host (Node.js or web worker).
- **Never import Node.js built-ins** (`node:fs`, `node:path`, `node:child_process`, etc.) in extension host service code.
  Use `vscode.workspace.fs`, `vscode.Uri.joinPath`, and the helpers in `src/utils/fs.ts` instead.
  The web extension entry point re-exports the desktop entry point; any Node.js import breaks the browser bundle.
- Follow the TypeScript and web-compatibility guidelines in the root `AGENTS.md` and `.github/instructions/ts.instructions.md`.

## Fluent UI React v9

This VS Code extension uses Microsoft Fluent UI React v9 components. Always use these components as UI building blocks.

Fluent UI React is a library of React components that implement Microsoft's [Fluent Design System](https://fluent2.microsoft.design).

- [Concepts/Introduction](https://storybooks.fluentui.dev/react//llms/concepts-introduction.txt)
- [Concepts/Developer/Quick Start](https://storybooks.fluentui.dev/react//llms/concepts-developer-quick-start.txt)
- [Concepts/Developer/Styling Components](https://storybooks.fluentui.dev/react//llms/concepts-developer-styling-components.txt)
- [Concepts/Developer/Positioning Components](https://storybooks.fluentui.dev/react//llms/concepts-developer-positioning-components.txt): Fluent components that make use of positioning can all be configured in the same way. Some components which make use of
- [Concepts/Developer/Server-Side Rendering/Basic setup](https://storybooks.fluentui.dev/react//llms/concepts-developer-server-side-rendering-basic-setup.txt)
- [Concepts/Developer/Server-Side Rendering/Limitations with Portals](https://storybooks.fluentui.dev/react//llms/concepts-developer-server-side-rendering-limitations-with-portals.txt)
- [Concepts/Developer/Server-Side Rendering/Next.js appDir setup](https://storybooks.fluentui.dev/react//llms/concepts-developer-server-side-rendering-next-js-appdir-setup.txt)
- [Concepts/Developer/Server-Side Rendering/Next.js pages setup](https://storybooks.fluentui.dev/react//llms/concepts-developer-server-side-rendering-next-js-pages-setup.txt)
- [Concepts/Developer/Server-Side Rendering/React Router 7 and Remix setup](https://storybooks.fluentui.dev/react//llms/concepts-developer-server-side-rendering-react-router-7-and-remix-setup.txt)
- [Concepts/Developer/Accessibility/Component labelling](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-component-labelling.txt)
- [Concepts/Developer/Accessibility/Components/Dropdown](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-components-dropdown.txt)
- [Concepts/Developer/Accessibility/Components/SpinButton](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-components-spinbutton.txt)
- [Concepts/Developer/Accessibility/Components Overview](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-components-overview.txt)
- [Concepts/Developer/Accessibility/Debugging notifications](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-debugging-notifications.txt)
- [Concepts/Developer/Accessibility/Experiences](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-experiences.txt)
- [Concepts/Developer/Accessibility/Focus indicator](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-focus-indicator.txt)
- [Concepts/Developer/Accessibility/Notification Best Practices](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-notification-best-practices.txt)
- [Concepts/Developer/Accessibility/Scenarios](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-scenarios.txt)
- [Concepts/Developer/Accessibility/Scenarios](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-scenarios.txt)
- [Concepts/Developer/Accessibility/Truncation](https://storybooks.fluentui.dev/react//llms/concepts-developer-accessibility-truncation.txt)
- [Concepts/Developer/Advanced Configuration](https://storybooks.fluentui.dev/react//llms/concepts-developer-advanced-configuration.txt)
- [Concepts/Developer/Advanced Styling Techniques](https://storybooks.fluentui.dev/react//llms/concepts-developer-advanced-styling-techniques.txt)
- [Concepts/Developer/Browser Support Matrix](https://storybooks.fluentui.dev/react//llms/concepts-developer-browser-support-matrix.txt)
- [Concepts/Developer/Build time styles](https://storybooks.fluentui.dev/react//llms/concepts-developer-build-time-styles.txt)
- [Concepts/Developer/Customizing Components with Slots](https://storybooks.fluentui.dev/react//llms/concepts-developer-customizing-components-with-slots.txt)
- [Concepts/Developer/React Version Support](https://storybooks.fluentui.dev/react//llms/concepts-developer-react-version-support.txt)
- [Concepts/Developer/Supported Platforms](https://storybooks.fluentui.dev/react//llms/concepts-developer-supported-platforms.txt)
- [Concepts/Developer/Theming](https://storybooks.fluentui.dev/react//llms/concepts-developer-theming.txt)
- [Concepts/Developer/Unprocessed Styles](https://storybooks.fluentui.dev/react//llms/concepts-developer-unprocessed-styles.txt)
- [Concepts/Developer/Web Components Interop/Using Fluent React with Web Components](https://storybooks.fluentui.dev/react//llms/concepts-developer-web-components-interop-using-fluent-react-with-web-components.txt)
- [Concepts/Migration/Getting Started](https://storybooks.fluentui.dev/react//llms/concepts-migration-getting-started.txt)
- [Concepts/Migration/Keeping Design Consistent](https://storybooks.fluentui.dev/react//llms/concepts-migration-keeping-design-consistent.txt)
- [Concepts/Migration/Handling Breaking Changes](https://storybooks.fluentui.dev/react//llms/concepts-migration-handling-breaking-changes.txt)
- [Concepts/Migration/from v8/Component Mapping](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-component-mapping.txt)
- [Concepts/Migration/from v8/Color Mapping](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-color-mapping.txt)
- [Concepts/Migration/from v8/Troubleshooting](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-troubleshooting.txt)
- [Concepts/Migration/from v8/Components/AvatarGroup Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-avatargroup-migration.txt)
- [Concepts/Migration/from v8/Components/Button Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-button-migration.txt)
- [Concepts/Migration/from v8/Components/Card Migration/Card](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-card-migration-card.txt)
- [Concepts/Migration/from v8/Components/Card Migration/CardFooter](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-card-migration-cardfooter.txt)
- [Concepts/Migration/from v8/Components/Card Migration/CardHeader](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-card-migration-cardheader.txt)
- [Concepts/Migration/from v8/Components/Card Migration/CardPreview](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-card-migration-cardpreview.txt)
- [Concepts/Migration/from v8/Components/Charts Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-charts-migration.txt)
- [Concepts/Migration/from v8/Components/Checkbox Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-checkbox-migration.txt)
- [Concepts/Migration/from v8/Components/ChoiceGroup to RadioGroup Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-choicegroup-to-radiogroup-migration.txt)
- [Concepts/Migration/from v8/Components/ColorPicker Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-colorpicker-migration.txt)
- [Concepts/Migration/from v8/Components/Flex/Stack](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-flex-stack.txt)
- [Concepts/Migration/from v8/Components/Flex/Stack item](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-flex-stack-item.txt)
- [Concepts/Migration/from v8/Components/GroupedList Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-groupedlist-migration.txt)
- [Concepts/Migration/from v8/Components/Image Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-image-migration.txt)
- [Concepts/Migration/from v8/Components/Keytips Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-keytips-migration.txt)
- [Concepts/Migration/from v8/Components/Label Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-label-migration.txt)
- [Concepts/Migration/from v8/Components/Menu Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-menu-migration.txt)
- [Concepts/Migration/from v8/Components/Separator to Divider Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-separator-to-divider-migration.txt)
- [Concepts/Migration/from v8/Components/Slider Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-slider-migration.txt)
- [Concepts/Migration/from v8/Components/SpinButton Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-spinbutton-migration.txt)
- [Concepts/Migration/from v8/Components/Spinner Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-spinner-migration.txt)
- [Concepts/Migration/from v8/Components/Tabs (Pivot) Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-tabs-pivot-migration.txt)
- [Concepts/Migration/from v8/Components/Textarea Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-textarea-migration.txt)
- [Concepts/Migration/from v8/Components/TextField to Input Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-textfield-to-input-migration.txt)
- [Concepts/Migration/from v8/Components/Theme Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v8-components-theme-migration.txt)
- [Concepts/Migration/from v0/Components/Avatar Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-avatar-migration.txt)
- [Concepts/Migration/from v0/Components/Box Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-box-migration.txt)
- [Concepts/Migration/from v0/Components/Button Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-button-migration.txt)
- [Concepts/Migration/from v0/Components/Card Migration/Card](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-card-migration-card.txt)
- [Concepts/Migration/from v0/Components/Card Migration/CardBody](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-card-migration-cardbody.txt)
- [Concepts/Migration/from v0/Components/Card Migration/CardFooter](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-card-migration-cardfooter.txt)
- [Concepts/Migration/from v0/Components/Card Migration/CardHeader](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-card-migration-cardheader.txt)
- [Concepts/Migration/from v0/Components/Card Migration/CardPreview](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-card-migration-cardpreview.txt)
- [Concepts/Migration/from v0/Components/Checkbox Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-checkbox-migration.txt)
- [Concepts/Migration/from v0/Components/Divider Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-divider-migration.txt)
- [Concepts/Migration/from v0/Components/Flex Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-flex-migration.txt)
- [Concepts/Migration/from v0/Components/FlexItem Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-flexitem-migration.txt)
- [Concepts/Migration/from v0/Components/Grid Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-grid-migration.txt)
- [Concepts/Migration/from v0/Components/Header Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-header-migration.txt)
- [Concepts/Migration/from v0/Components/Image Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-image-migration.txt)
- [Concepts/Migration/from v0/Components/Input Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-input-migration.txt)
- [Concepts/Migration/from v0/Components/ItemLayout Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-itemlayout-migration.txt)
- [Concepts/Migration/from v0/Components/Label Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-label-migration.txt)
- [Concepts/Migration/from v0/Components/Loader Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-loader-migration.txt)
- [Concepts/Migration/from v0/Components/Loader to Spinner Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-loader-to-spinner-migration.txt)
- [Concepts/Migration/from v0/Components/Menu Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-menu-migration.txt)
- [Concepts/Migration/from v0/Components/Popup Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-popup-migration.txt)
- [Concepts/Migration/from v0/Components/RadioGroup Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-radiogroup-migration.txt)
- [Concepts/Migration/from v0/Components/Ref Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-ref-migration.txt)
- [Concepts/Migration/from v0/Components/Segment Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-segment-migration.txt)
- [Concepts/Migration/from v0/Components/Slider Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-slider-migration.txt)
- [Concepts/Migration/from v0/Components/SplitButton Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-splitbutton-migration.txt)
- [Concepts/Migration/from v0/Components/TabList Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-tablist-migration.txt)
- [Concepts/Migration/from v0/Components/Text Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-text-migration.txt)
- [Concepts/Migration/from v0/Components/Textarea Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-textarea-migration.txt)
- [Concepts/Migration/from v0/Components/Toolbar Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-toolbar-migration.txt)
- [Concepts/Migration/from v0/Components/Tooltip Migration](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-components-tooltip-migration.txt)
- [Concepts/Migration/from v0/Custom Accessibility](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-custom-accessibility.txt)
- [Concepts/Migration/from v0/Custom Style Overrides](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-custom-style-overrides.txt)
- [Concepts/Migration/from v0/Icons](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-icons.txt)
- [Concepts/Migration/from v0/Positioning](https://storybooks.fluentui.dev/react//llms/concepts-migration-from-v0-positioning.txt)
- [Concepts/Recipes/Media Object](https://storybooks.fluentui.dev/react//llms/concepts-recipes-media-object.txt)
- [Concepts/Package Maturity Levels](https://storybooks.fluentui.dev/react//llms/concepts-package-maturity-levels.txt)
- [Theme/Border Radii](https://storybooks.fluentui.dev/react//llms/theme-border-radii.txt)
- [Theme/Colors](https://storybooks.fluentui.dev/react//llms/theme-colors.txt)
- [Theme/Fonts](https://storybooks.fluentui.dev/react//llms/theme-fonts.txt)
- [Theme/Shadows](https://storybooks.fluentui.dev/react//llms/theme-shadows.txt)
- [Theme/Spacing](https://storybooks.fluentui.dev/react//llms/theme-spacing.txt)
- [Theme/Stroke Widths](https://storybooks.fluentui.dev/react//llms/theme-stroke-widths.txt)
- [Theme/Typography](https://storybooks.fluentui.dev/react//llms/theme-typography.txt)
- [Theme/Theme Designer](https://storybooks.fluentui.dev/react//llms/theme-theme-designer.txt)
- [Components/Accordion](https://storybooks.fluentui.dev/react//llms/components-accordion.txt): An accordion allows users to toggle the display of content by expanding or collapsing sections.
- [Components/Avatar](https://storybooks.fluentui.dev/react//llms/components-avatar.txt): An Avatar is a graphical representation of a user, team, or entity.
- [Components/AvatarGroup](https://storybooks.fluentui.dev/react//llms/components-avatargroup.txt): An AvatarGroup is a graphical representation of multiple people associated with a given entity. AvatarGroup leverages the Avatar component, with each Avatar representing a person and containing their image, initials, or an icon. An AvatarGroup can be represented
- [Components/Badge/Badge](https://storybooks.fluentui.dev/react//llms/components-badge-badge.txt): A badge is a visual decoration for UI elements.
- [Components/Badge/Counter Badge](https://storybooks.fluentui.dev/react//llms/components-badge-counter-badge.txt): A counter badge is a badge that displays a numerical count.
- [Components/Badge/PresenceBadge](https://storybooks.fluentui.dev/react//llms/components-badge-presencebadge.txt): A presence badge is a badge that displays a status indicator such as available, away, or busy.
- [Components/Breadcrumb](https://storybooks.fluentui.dev/react//llms/components-breadcrumb.txt): For detailed guidance on when and how to use this component, go to Fluent 2 Breadcrumbs.
- [Components/Button/Button](https://storybooks.fluentui.dev/react//llms/components-button-button.txt): A button triggers an action or event when activated.
- [Components/Button/CompoundButton](https://storybooks.fluentui.dev/react//llms/components-button-compoundbutton.txt): A compound button is a button with an additional slot for secondary textual content.
- [Components/Button/MenuButton](https://storybooks.fluentui.dev/react//llms/components-button-menubutton.txt): A menu button is a button with a chevron icon after the text typically used to trigger a menu.
- [Components/Button/SplitButton](https://storybooks.fluentui.dev/react//llms/components-button-splitbutton.txt): A split button is a button with a primary action and a secondary action primarily used for opening a menu.
- [Components/Button/ToggleButton](https://storybooks.fluentui.dev/react//llms/components-button-togglebutton.txt): A toggle button is a button that can be checked on and off.
- [Components/Card/Card](https://storybooks.fluentui.dev/react//llms/components-card-card.txt): A card is a container that holds information and actions related to a single concept or object, like a document or a contact.
- [Components/Card/CardFooter](https://storybooks.fluentui.dev/react//llms/components-card-cardfooter.txt): The CardFooter component, used inside of a Card, uses a flex layout to organize actions the user can take with a Card, like sharing the contents or replying to a message.
- [Components/Card/CardHeader](https://storybooks.fluentui.dev/react//llms/components-card-cardheader.txt): The CardHeader component, used inside of a Card, represents a Fluent UI compliant card header.
- [Components/Card/CardPreview](https://storybooks.fluentui.dev/react//llms/components-card-cardpreview.txt): The CardPreview component, used inside of a Card, allows the user to better visualize what the card's contents are.
- [Components/Carousel/Carousel](https://storybooks.fluentui.dev/react//llms/components-carousel-carousel.txt): A `Carousel` component is a sliding window of elements controlled by previous, next, and direct pagination buttons.
- [Components/Carousel/CarouselNav](https://storybooks.fluentui.dev/react//llms/components-carousel-carouselnav.txt): `CarouselNav` provides an index based pagination of the Carousel containing it.
- [Components/Checkbox](https://storybooks.fluentui.dev/react//llms/components-checkbox.txt)
- [Components/ColorPicker](https://storybooks.fluentui.dev/react//llms/components-colorpicker.txt): The ColorPicker allows users to browse and select colors.
- [Components/Combobox](https://storybooks.fluentui.dev/react//llms/components-combobox.txt): A combobox (`Combobox`) combines a text field and a dropdown giving people a way to select an option from a list or enter their own choice.
- [Components/DataGrid](https://storybooks.fluentui.dev/react//llms/components-datagrid.txt): > 💡 This component is a higher level extension of the `Table` primitive components and the `useTableFeatures` hook.
- [Components/Dialog](https://storybooks.fluentui.dev/react//llms/components-dialog.txt): `Dialog` is a window overlaid on either the primary window or another dialog window. Windows under a modal dialog are inert. That is, users cannot interact with content outside an active dialog window. Inert content outside an active dialog is typically visually obscured or dimmed so it is difficult to discern, and in some implementations, attempts to interact with the inert content cause the dialog to close.
- [Components/Divider](https://storybooks.fluentui.dev/react//llms/components-divider.txt): A divider visually separates two pieces of content.
- [Components/Drawer](https://storybooks.fluentui.dev/react//llms/components-drawer.txt): The Drawer gives users a quick entry point to configuration and information. It should be used when retaining context is beneficial to users.
- [Components/Dropdown](https://storybooks.fluentui.dev/react//llms/components-dropdown.txt): A Dropdown is a selection component composed of a button and a list of options. The button displays the current selected item or a placeholder, and the list is visible on demand by clicking the button. Dropdowns are typically used in forms.
- [Components/Field](https://storybooks.fluentui.dev/react//llms/components-field.txt): Field adds a label, validation message, and hint text to a control.
- [Components/FluentProvider](https://storybooks.fluentui.dev/react//llms/components-fluentprovider.txt): The FluentProvider transforms a passed theme to CSS variables and passes other settings to Fluent UI components.
- [Components/Image](https://storybooks.fluentui.dev/react//llms/components-image.txt): An image displays graphical content such as a photo or illustration.
- [Components/InfoLabel](https://storybooks.fluentui.dev/react//llms/components-infolabel.txt): An InfoLabel is a Label with an InfoButton at the end, properly handling layout and accessibility properties.
- [Components/Input](https://storybooks.fluentui.dev/react//llms/components-input.txt): Input allows the user to enter and edit text.
- [Components/Label](https://storybooks.fluentui.dev/react//llms/components-label.txt): A label provides a name or title for an input.
- [Components/Link](https://storybooks.fluentui.dev/react//llms/components-link.txt): Links allow users to navigate between different locations. They can be used as standalone controls or inline with text.
- [Components/List](https://storybooks.fluentui.dev/react//llms/components-list.txt): The List is a component for rendering set of vertically stacked items (other layouts are being discussed). These items can be focusable, selectable, have one primary action and one or more secondary actions.
- [Components/Menu/Menu](https://storybooks.fluentui.dev/react//llms/components-menu-menu.txt): A menu displays a list of actions. The Menu component handles the
- [Components/Menu/MenuList](https://storybooks.fluentui.dev/react//llms/components-menu-menulist.txt): A menu list displays a list of actions. It is usually rendered inside of the Menu component.
- [Components/MessageBar](https://storybooks.fluentui.dev/react//llms/components-messagebar.txt): Communicates important information about the state of the entire application or surface.
- [Components/Nav](https://storybooks.fluentui.dev/react//llms/components-nav.txt): A component that provides up to two levels of nesting for navigation.
- [Components/Overflow](https://storybooks.fluentui.dev/react//llms/components-overflow.txt): The `Overflow` and `OverflowItem` components, are low level utilities that enable users to create overflow
- [Components/Persona](https://storybooks.fluentui.dev/react//llms/components-persona.txt): A Persona is a visual representation of a person or status that showcases an Avatar, PresenceBadge, or an Avatar with a PresenceBadge.
- [Components/Popover](https://storybooks.fluentui.dev/react//llms/components-popover.txt): A popover displays content on top of other content.
- [Components/Portal/Portal](https://storybooks.fluentui.dev/react//llms/components-portal-portal.txt): A portal renders content outside of a DOM tree, at the end of the document. This allows content to escape traditional boundaries caused by `"overflow: hidden"` CSS rules and keeps it on the top without using `z-index` rules. This is useful for example in `Menu` and `Tooltip` scenarios, where the content should always overlay everything else.
- [Components/Portal/toMountNodeProps](https://storybooks.fluentui.dev/react//llms/components-portal-tomountnodeprops.txt): Fluent UI uses a wrapper component called `Portal` to render portals using [`ReactDOM.createPortal()`](https://react.dev/reference/react-dom/createPortal).
- [Components/ProgressBar](https://storybooks.fluentui.dev/react//llms/components-progressbar.txt): A ProgressBar provides a visual representation of content being loaded or processed.
- [Components/RadioGroup](https://storybooks.fluentui.dev/react//llms/components-radiogroup.txt): RadioGroup lets people select a single option from two or more Radio items. Use RadioGroup to present all available choices if there's enough space. For more than 5 choices, consider using a different component such as Dropdown.
- [Components/Rating](https://storybooks.fluentui.dev/react//llms/components-rating.txt): A `Rating` component allows users to provide a rating for a particular item.
- [Components/RatingDisplay](https://storybooks.fluentui.dev/react//llms/components-ratingdisplay.txt): `RatingDisplay` is used to communicate user sentiment. By default, it shows rating as filled stars out of 5, as well as a text displaying the average value and the aggregate number of ratings.
- [Components/SearchBox](https://storybooks.fluentui.dev/react//llms/components-searchbox.txt): <!-- Don't allow prettier to collapse code block into single line -->
- [Components/Select](https://storybooks.fluentui.dev/react//llms/components-select.txt): A Select allows one option to be selected from multiple options. The Select component is a wrapper around the native `<select>` element.
- [Components/Skeleton](https://storybooks.fluentui.dev/react//llms/components-skeleton.txt): The `Skeleton` component is a temporary animation placeholder for when a service call takes time to return data and we don't want to block rendering the rest of the UI.
- [Components/Slider](https://storybooks.fluentui.dev/react//llms/components-slider.txt): A Slider represents an input that allows user to choose a value from within a specific range.
- [Components/SpinButton](https://storybooks.fluentui.dev/react//llms/components-spinbutton.txt): SpinButtons are used to allow numerical and non-numerical input bounded between minimum and maximum values with buttons to increment and decrement the input value.
- [Components/Spinner](https://storybooks.fluentui.dev/react//llms/components-spinner.txt): A spinner alerts a user that content is being loaded or processed and they should wait for the activity to complete.
- [Components/SwatchPicker](https://storybooks.fluentui.dev/react//llms/components-swatchpicker.txt): A swatch picker lets people choose a color, image, or pattern and apply it to graphics or text.
- [Components/Switch](https://storybooks.fluentui.dev/react//llms/components-switch.txt): A switch represents a physical switch that allows someone to choose between two mutually exclusive options. For example, "On/Off" and "Show/Hide". Choosing an option should produce an immediate result.
- [Components/Table](https://storybooks.fluentui.dev/react//llms/components-table.txt): > 💡 This component is considered **low-level** and should be used when there is a need for more **customization** and
- [Components/TabList](https://storybooks.fluentui.dev/react//llms/components-tablist.txt): A tab list provides single selection from tabs. When a tab is selected, the application displays content associated with the selected tab and hides other content.
- [Components/Tag/InteractionTag](https://storybooks.fluentui.dev/react//llms/components-tag-interactiontag.txt): A InteractionTag follows the same characteristics as a Tag, but with the added functionality of having a primary and secondary action. This is mostly used in scenarios where gaining more context for a InteractionTag is available for the user, an example would be clicking into a persona to expand their profile page.
- [Components/Tag/Tag](https://storybooks.fluentui.dev/react//llms/components-tag-tag.txt): A Tag provides a visual representation of an attribute, person, or asset.
- [Components/Tag/TagGroup](https://storybooks.fluentui.dev/react//llms/components-tag-taggroup.txt): A TagGroup is a container for multiple controls that are Tag or InteractionTag.
- [Components/TagPicker](https://storybooks.fluentui.dev/react//llms/components-tagpicker.txt): A `TagPicker` combines a text field and a dropdown giving people a way to select an option from a list or enter their own choice. It is a specialized version of a [`Combobox`](https://react.fluentui.dev/?path=/docs/components-combobox--default) where selecting an option from a list results in a [`Tag`](https://react.fluentui.dev/?path=/docs/components-tag-tag--default) being added close to the text field.
- [Components/TeachingPopover](https://storybooks.fluentui.dev/react//llms/components-teachingpopover.txt)
- [Components/Text](https://storybooks.fluentui.dev/react//llms/components-text.txt): Typography and styling abstraction component used to ensure consistency and standardize text throughout your application.
- [Components/Textarea](https://storybooks.fluentui.dev/react//llms/components-textarea.txt): Textarea allows the user to enter and edit multiline text.
- [Components/Toast](https://storybooks.fluentui.dev/react//llms/components-toast.txt): A Toasts displays temporary content to the user. Toasts are rendered as a separate surface that can be dismissed by
- [Components/Toolbar](https://storybooks.fluentui.dev/react//llms/components-toolbar.txt): A toolbar is a container for grouping a set of controls, such as buttons, menu buttons, or checkboxes.
- [Components/Tooltip](https://storybooks.fluentui.dev/react//llms/components-tooltip.txt): A tooltip displays additional information about another component.
- [Components/Tree](https://storybooks.fluentui.dev/react//llms/components-tree.txt): A hierarchical list structure component for displaying data in a collapsible and expandable way.
- [Compat Components/Calendar](https://storybooks.fluentui.dev/react//llms/compat-components-calendar.txt): The calendar control lets people select and view a single date or a range of dates in their calendar. It’s made up of 3 separate views: the month view, year view, and decade view.
- [Compat Components/DatePicker](https://storybooks.fluentui.dev/react//llms/compat-components-datepicker.txt): Picking a date can be tough without context. A date picker (DatePicker) offers a popup control that’s optimized for picking a single date from a calendar view where contextual information like the day of the week or fullness of the calendar is important. You can modify the calendar to provide additional context or to limit available dates.
- [Compat Components/TimePicker](https://storybooks.fluentui.dev/react//llms/compat-components-timepicker.txt): `TimePicker` offers a control that’s optimized for selecting a time from a drop-down list or using free-form input to enter a custom time.
- [Preview Components/Menu/MenuGrid](https://storybooks.fluentui.dev/react//llms/preview-components-menu-menugrid.txt): A menu grid displays a complex menu structured as grid with sub-actions. It is usually rendered inside of the `Menu` component.
- [Icons/Overview](https://storybooks.fluentui.dev/react//llms/icons-overview.txt): The `@fluentui/react-icons` package provides [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) icon set. Each icon within this set is encapsulated within a React component, utilizing SVG-based graphics. Icons are available in two distinct styles: `Filled` and `Regular`.
- [Icons/Catalog](https://storybooks.fluentui.dev/react//llms/icons-catalog.txt)
- [Icons/Advanced Usage](https://storybooks.fluentui.dev/react//llms/icons-advanced-usage.txt)
- [Motion/APIs/createMotionComponent](https://storybooks.fluentui.dev/react//llms/motion-apis-createmotioncomponent.txt): `createMotionComponent()` is a factory function that creates a custom motion component powered by Web Animations API.
- [Motion/APIs/createMotionComponentVariant](https://storybooks.fluentui.dev/react//llms/motion-apis-createmotioncomponentvariant.txt): `createMotionComponentVariant()` is a factory function that creates a new motion component based on an existing motion component, using the provided variant parameters as defaults.
- [Motion/APIs/createPresenceComponent](https://storybooks.fluentui.dev/react//llms/motion-apis-createpresencecomponent.txt): `createPresenceComponent()` is a factory function that creates a React component based on the provided presence definition. This component can be used to animate any element and intended to have a state via the `visible` prop.
- [Motion/APIs/PresenceGroup](https://storybooks.fluentui.dev/react//llms/motion-apis-presencegroup.txt): `PresenceGroup` is a component that manages a set of components created with `createPresenceComponent()` in a list. `PresenceGroup` is a state machine for managing the mounting and unmounting of components over time.
- [Motion/Choreography (preview)/Stagger](https://storybooks.fluentui.dev/react//llms/motion-choreography-preview-stagger.txt): > **⚠️ Preview components are considered unstable**
- [Motion/Components (preview)/Blur](https://storybooks.fluentui.dev/react//llms/motion-components-preview-blur.txt): The `Blur` component manages content presence, using blur in/out transitions.
- [Motion/Components (preview)/Collapse](https://storybooks.fluentui.dev/react//llms/motion-components-preview-collapse.txt): The `Collapse` component manages content [presence](?path=/docs/motion-apis-createpresencecomponent--docs), using a height or width expand/collapse motion.
- [Motion/Components (preview)/Fade](https://storybooks.fluentui.dev/react//llms/motion-components-preview-fade.txt): The `Fade` component manages content presence, using fade in/out.
- [Motion/Components (preview)/Rotate](https://storybooks.fluentui.dev/react//llms/motion-components-preview-rotate.txt): The Rotate component provides 3D rotation animations with independent X, Y, and Z axis control.
- [Motion/Components (preview)/Scale](https://storybooks.fluentui.dev/react//llms/motion-components-preview-scale.txt): The `Scale` component manages content presence, using scale in/out.
- [Motion/Components (preview)/Slide](https://storybooks.fluentui.dev/react//llms/motion-components-preview-slide.txt): The `Slide` component manages content presence, using slide in/out transitions.
- [Motion/Motion Slot](https://storybooks.fluentui.dev/react//llms/motion-motion-slot.txt): Fluent components leverages the `@fluentui/react-motion` to handle animations. All components that expose a motion slot, can be configured in a similar way. For detailed guidance on creating animations using `@fluentui/react-motion`, refer to the [motion API](https://react.fluentui.dev/?path=/docs/motion-apis-createpresencecomponent--docs) documentation.
- [Motion/Tokens](https://storybooks.fluentui.dev/react//llms/motion-tokens.txt)
- [Utilities/ARIA live/AriaLiveAnnouncer](https://storybooks.fluentui.dev/react//llms/utilities-aria-live-arialiveannouncer.txt): `AriaLiveAnnouncer` provides a sample implementation of an `aria-live` region that can be used to announce messages to screen readers.
- [Utilities/ARIA live/useAnnounce](https://storybooks.fluentui.dev/react//llms/utilities-aria-live-useannounce.txt): `useAnnounce()` is a React hook that provides a function that can be used to announce messages to screen readers.
- [Utilities/ARIA live/useTypingAnnounce](https://storybooks.fluentui.dev/react//llms/utilities-aria-live-usetypingannounce.txt): `useTypingAnnounce` takes a reference to an element (which should be an `input`, `textarea`, or `contenteditable`) and returns a ref to put on the editable input element and a `typingAnnounce` function with the same paramters as the `announce` function returned by `useAnnounce`.
- [Utilities/Focus Management/useArrowNavigationGroup](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-usearrownavigationgroup.txt): This hook enables keyboard navigation using the arrow keys (up/down/left/right), among a collection of
- [Utilities/Focus Management/useFocusableGroup](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-usefocusablegroup.txt): This hook applies specific focus behaviour for focusable elements that contain other nested focusable elements.
- [Utilities/Focus Management/useFocusFinders](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-usefocusfinders.txt): This hook returns utility functions to find focusable elements, which can be useful when creating
- [Utilities/Focus Management/useModalAttributes](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-usemodalattributes.txt): This hook is a helper to create modal dialog like experiences. The hook creates accessible focus traps that set
- [Utilities/Focus Management/useObservedElement](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-useobservedelement.txt): Observed elements are a way to assign a name to an element that is not a
- [Utilities/Focus Management/useRestoreFocusSource](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-userestorefocussource.txt): The hooks `useRestoreFocusSource` and `useRestoreFocusTarget` are intended to be used together, but without tight
- [Utilities/Focus Management/useUncontrolledFocus](https://storybooks.fluentui.dev/react//llms/utilities-focus-management-useuncontrolledfocus.txt): Fluent UI focus management is handled by [Tabster](http://tabster.io/). Tabster is intended to be used as the
- [Utilities/Positioning/useSafeZoneArea](https://storybooks.fluentui.dev/react//llms/utilities-positioning-usesafezonearea.txt): # useSafeZoneArea
- [Utilities/Theme/createCSSRuleFromTheme](https://storybooks.fluentui.dev/react//llms/utilities-theme-createcssrulefromtheme.txt): This API allows you to create CSS from a theme and apply this CSS, for example, to `<body>`.
- [Migration Shims/V0/Attachment](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-attachment.txt): # Attachment
- [Migration Shims/V0/ButtonMixins](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-buttonmixins.txt): The [Button](https://fluentsite.z22.web.core.windows.net/0.65.0/components/button/definition) Mixins add styles for the disabled cursor and for `@fluentui/react-northstar` icon
- [Migration Shims/V0/FlexShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-flexshim.txt)
- [Migration Shims/V0/FormFieldShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-formfieldshim.txt): The FormFieldShim component accepts the same props as a v0 FormField and renders a v9 Field.
- [Migration Shims/V0/GridShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-gridshim.txt): The GridShim serves as shim to replace V0 Grid component.
- [Migration Shims/V0/InputMixins](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-inputmixins.txt): Input mixins exist to help you to achieve few specific states of V0 Input
- [Migration Shims/V0/List](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-list.txt): To unlock the migration to V9, we have created the List v0 Shim component, which is a stepping stone implementation of List, that respects new paradigms introduced in v9 but keeps the API and experience as close to [List v0](https://fluentsite.z22.web.core.windows.net/components/list) as possible.
- [Migration Shims/V0/SegmentShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-segmentshim.txt): The SegmentShim serves as shim to replace V0 Segment component.
- [Migration Shims/V0/SliderMixin](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-slidermixin.txt): The Slider Mixin adds styles to match V0 props.
- [Migration Shims/V0/SpinnerMixins](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-spinnermixins.txt): The Spinner Mixin adds styles to match `@fluentui/react-northstar` [Loader](https://fluentsite.z22.web.core.windows.net/0.65.0/components/loader/definition).
- [Migration Shims/V0/Video](https://storybooks.fluentui.dev/react//llms/migration-shims-v0-video.txt): # Video Component
- [Migration Shims/V8/Button/ActionButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-actionbuttonshim.txt): The ActionButtonShim component accepts the same props as a v8 ActionButton and renders a v9 Button.
- [Migration Shims/V8/Button/CommandButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-commandbuttonshim.txt): The DefaultButtonShim component accepts the same props as a v8 DefaultButton and renders a v9 Button.
- [Migration Shims/V8/Button/CompoundButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-compoundbuttonshim.txt): The CompoundButtonShim component accepts the same props as a v8 CompoundButton and renders a v9 CompoundButton.
- [Migration Shims/V8/Button/DefaultButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-defaultbuttonshim.txt): The DefaultButtonShim component accepts the same props as a v8 DefaultButton and renders a v9 Button.
- [Migration Shims/V8/Button/MenuButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-menubuttonshim.txt): The MenuButtonShim component accepts the same props as a v8 DefaultButton with menuProps and renders a v9 MenuButton.
- [Migration Shims/V8/Button/PrimaryButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-primarybuttonshim.txt): The PrimaryButtonShim component accepts the same props as a v8 PrimaryButton and renders a v9 Button.
- [Migration Shims/V8/Button/ToggleButtonShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-button-togglebuttonshim.txt): The ToggleButtonShim component accepts the same props as a v8 DefaultButton with the toggle prop set and renders a v9 ToggleButton.
- [Migration Shims/V8/CheckboxShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-checkboxshim.txt): The CheckboxShim component accepts the same props as a v8 Checkbox and renders a v9 Checkbox.
- [Migration Shims/V8/StackShim](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-stackshim.txt): The StackShim and StackItemShim accept the same props a v8 Stack and StackItem and render equivalent HTML and stylings to provide layout using CSS flexbox.
- [Migration Shims/V8/Theme/createBrandVariants](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-theme-createbrandvariants.txt): The createBrandVariants shim method allows you to create a v9 BrandVariants (a.k.a brand ramp) from a v8 Palette.
- [Migration Shims/V8/Theme/createV8Theme](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-theme-createv8theme.txt): The createV8Theme shim method allows you to create a v8 Theme from a BrandVariants (a.k.a brand ramp) and a v9 Theme.
- [Migration Shims/V8/Theme/createV9Theme](https://storybooks.fluentui.dev/react//llms/migration-shims-v8-theme-createv9theme.txt): The createV9Theme shim method allows you to create a v9 Theme from a v8 Theme.

## Optional

- [Contributors Packages](https://microsoft.github.io/fluentui-contrib/docsite/llms.txt)
- [Charts v9](https://storybooks.fluentui.dev/charts/llms.txt)
