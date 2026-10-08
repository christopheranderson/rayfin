# Samples Overview

These samples are used by Contributors during active development of the Rayfin platform.
They help Contributors understand current features and validate SDK functionality in realistic application scenarios.

Each sample is a working application that can be run in the current state using Rush commands from within the monorepo.
Samples are not published to npm; they remain in the repository for development and testing purposes.

## Available Samples

- **todo-app** - Full-featured todo application with authentication, data management, categories, and storage integration
- **getting-started-auth** - Todo app with Fabric auth, Tailwind/shadcn UI, and production-first workflow
- **notes-app** - Note-taking application with authentication, data management, and Rayfin integration
- **eshop** - E-commerce sample showcasing more complex data and service patterns
- **events-app** - Events management sample focused on scheduling and listings
- **workspace-todo-app** - Todo sample that demonstrates npm workspaces with separate frontend, data, functions, and shared packages wired through `rayfin.yml` service paths
- **welcome-app-react-auth** - Intermediate React welcome app with auth.
- **welcome-app-react-no-auth** - Simple React welcome application
- **welcome-app-typescript** - Simple TypeScript welcome application

## Converting Samples to Templates

Samples can be converted to templates that Builders can scaffold via `@microsoft/create-rayfin`.
This conversion is handled automatically by the `create-rayfin` build process during package publishing.

### Template Metadata

To mark a sample for conversion, add `template` metadata to its `package.json`:

```json
  "template": {
    "name": "todo-app",
    "displayName": "Todo App",
    "description": "Full-featured todo application with authentication, data management, and Rayfin integration"
  },
```

### Template Bundling Process

When `create-rayfin` is built for publishing, the `bundle-templates.ts` script performs the following transformations:

1. **Dependency resolution**: Converts `workspace:*` dependencies to published package versions (e.g., `workspace:*` → `^1.0.0`)
2. **File filtering**: Applies `.templateignore` patterns to exclude development-only files
3. **Template packaging**: Copies the transformed sample into the `create-rayfin/templates/` directory

### Template Ignore Files

Use `.templateignore` files to exclude files and directories from the bundled template:

- **Global exclusions**: `packages/tools/create-rayfin/scripts/.templateignore` applies to all templates
- **Template-specific exclusions**: Add a `.templateignore` file to the sample directory for additional patterns

The `.templateignore` format follows gitignore-style glob patterns.

### Template Scaffolding

When a Builder runs `npm create @microsoft/rayfin@latest`, the `create-rayfin` tool:

1. Copies the template to the new project directory
2. Updates `package.json` with the user's project name
3. Replaces template placeholders (`{{PROJECT_NAME}}`, `{{PROJECT_NAME_PASCAL}}`, `{{PROJECT_NAME_KEBAB}}`) in README and other files
4. Runs `rayfin init --from-template --project-name <name>` to configure `rayfin.yml`
