---
applyTo: '**/packages/tools/cli/**'
---

# Rayfin CLI Package Instructions

This document provides guidance for developing and testing the Rayfin CLI package (`@microsoft/rayfin-cli`).

## Package Overview

The Rayfin CLI is the command-line interface for the Rayfin platform, providing tools for project initialization, development, and deployment operations.

**Location**: `packages/tools/cli/`

**Key Commands**:
- `rayfin init` - Initialize a new Rayfin project
- `rayfin dev` - Development server and local operations (requires `RAYFIN_FEATURE_FLAGS=docker-local-dev`; includes db, storage, watch subcommands)
- `rayfin up` - Deploy to cloud services (includes db, storage subcommands)
- `rayfin docs` - Query version-locked docs from Rayfin packages installed in the current project
- `rayfin init ai-files install` - Install or refresh Rayfin agent files (`AGENTS.md`, `.mcp.json`, `.agents/skills/`)
- `rayfin init ai-files status` - Report managed Rayfin agent-file state

## Assets Folder and Template System

### Assets Directory Structure

The CLI uses an assets folder for template files and static resources:

```
packages/tools/cli/
├── assets/
│   ├── .gitignore.template          # Git ignore template
│   ├── docker-compose.yml           # Docker compose configuration
│   └── agent-files/                 # AGENTS.md, .mcp.json entry, and Rayfin skill assets
├── src/
│   └── commands/
│       └── init.ts                  # Contains template loading logic
└── dist/                            # Compiled output
```

### Template File Conventions

**File Naming**:
- Use `.template` extension for template files (e.g., `.gitignore.template`)
- Use descriptive names that match their target files
- For files without extensions, use the full filename (e.g., `docker-compose.yml`)

**Template Loading Pattern**:
```typescript
async function createContentFromTemplate(): Promise<string> {
  const assetsDir = resolve(__dirname, '..', '..', 'assets');
  const templatePath = join(assetsDir, 'template-file.template');

  try {
    const templateContent = await readFile(templatePath, 'utf8');
    return templateContent;
  } catch (error) {
    console.warn(
      '⚠️  Warning: Could not read template, using fallback content'
    );
    // Provide minimal fallback content
    return 'fallback content';
  }
}
```

**Best Practices**:
- Always provide fallback content in case template files are missing
- Use async/await for file reading operations
- Include descriptive warning messages for missing templates
- Read templates at runtime, not build time, to allow for easy template updates
- Keep agent-file assets aligned with the Rayfin MCP/docs surface so generated projects tell agents to use version-locked `rayfin docs` and MCP tools.

### Adding New Templates

1. **Create the template file** in `packages/tools/cli/assets/`
2. **Add template loading function** in the appropriate command file
3. **Integrate with existing file creation logic** following the established patterns
4. **Test the template** using the procedures below

## Development and Testing

### Development Setup

1. **Navigate to CLI package**:
   ```bash
   cd packages/tools/cli
   ```

2. **Install dependencies** (if not already done):
   ```bash
   rush update
   ```

3. **Build the package**:
   ```bash
   rush build
   ```

### Testing with npm link

The recommended approach for testing CLI changes during development:

1. **Build the CLI package**:
   ```bash
   rush build --to @microsoft/rayfin-cli
   ```

2. **Create a global link**:
   ```bash
   npm link
   ```
   This makes the `rayfin` command available globally. If you get a conflict error, you may need to run `npm link --force`.

3. **Create a test directory**:
   ```bash
   cd /tmp
   mkdir rayfin-test-$(date +%s)
   cd rayfin-test-*
   ```

4. **Create a basic package.json** (if testing package installation):
   ```bash
   echo '{"name": "test-project", "version": "1.0.0"}' > package.json
   ```

5. **Test the CLI commands**:
   ```bash
   rayfin init .
   rayfin --help
   rayfin init --help
   ```

6. **Verify created files**:
   ```bash
   find . -type f | sort
   cat AGENTS.md
   ```

7. **Cleanup after testing**:
   ```bash
   npm unlink -g
   ```



### Build Process

**Standard Build**:
```bash
rush build
```

**Force Clean Build** (if compilation issues):
```bash
rush build:force
```

**Clean Install and Build** (if dependency issues):
```bash
rush purge
rush update
rush build:force
```

## File Creation Patterns

### Standard File Creation Flow

The `init` command follows this pattern for creating files:

1. **Check if target file exists**
2. **Ask for overwrite confirmation** (if applicable)
3. **Create parent directories** with `{ recursive: true }`
4. **Load content** (from template or function)
5. **Write file** with proper encoding
6. **Track created/skipped files** for user feedback

### Example Implementation

```typescript
// Check if file exists
const filePath = join(projectRoot, 'AGENTS.md');
let fileExists = false;
try {
  await access(filePath, constants.F_OK);
  fileExists = true;
} catch {
  // File doesn't exist, continue
}

// Handle overwrite confirmation
if (fileExists) {
  const overwriteAnswer = await inquirer.prompt({
    type: 'confirm',
    name: 'overwrite',
    message: 'AGENTS.md already exists. Do you want to overwrite it?',
    default: false,
  });

  if (!overwriteAnswer.overwrite) {
    skippedFiles.push('AGENTS.md');
    return;
  }
}

// Create content and write file
const content = await createAgentsContent();
await writeFile(filePath, content, 'utf8');
createdFiles.push('AGENTS.md');
```

## Integration with Rayfin Workspace

### Development Mode Detection

The CLI automatically detects when running in the Rayfin development workspace and adjusts package installation accordingly:

- **Development mode**: Uses `file:` paths to local packages
- **Production mode**: Uses npm registry packages

### Package Installation

The init command handles Rayfin package installation:

```typescript
// Detect mode
const isDevelopmentMode = await isInDevelopmentMode();

if (isDevelopmentMode) {
  // Install from local workspace
  const localPackagePaths = await getLocalPackagePaths();
  await installLocalPackages(targetDirectory, localPackagePaths);
} else {
  // Install from npm registry
  await installRayfinPackages(targetDirectory);
}
```

## Testing Checklist

When making changes to the CLI, verify:

- [ ] Build completes without errors (`rush build`)
- [ ] All template files are accessible in compiled output
- [ ] `npm link` creates working global command
- [ ] `rayfin init` creates all expected files (including `AGENTS.md`)
- [ ] Template content is properly loaded from assets folder
- [ ] Overwrite confirmations work correctly
- [ ] File creation tracking works (created/skipped files listed)
- [ ] Package installation works in both dev and prod modes
- [ ] Error handling works for missing templates
- [ ] CLI help commands work (`rayfin --help`, `rayfin init --help`)

## Future Considerations

- Consider implementing template variable substitution for dynamic content
- Add validation for template file formats (e.g., YAML frontmatter validation)
- Implement template versioning for backward compatibility
- Add support for user-defined template directories
- Consider template inheritance for shared base templates

## Telemetry

The CLI includes an OpenTelemetry-based telemetry subsystem.
See `docs/rfc/client-telemetry.md` for architecture details.

### Key files

- `src/telemetry/index.ts` — SDK init, span creation, shutdown, Commander hooks.
- `src/telemetry/cli-policy.ts` — resolves `RAYFIN_TELEMETRY_OPTOUT` and calls shared gate.
- `src/telemetry/context-store.ts` — async-local storage for the current `InvocationContext`.
- `src/telemetry/device-id.ts` — generates and persists the anonymous installation ID in `~/.rayfin/`.
- `src/telemetry/first-run-notice.ts` — one-time stderr notice; marker file in `~/.rayfin/`.

### Shared code in `@microsoft/rayfin-tools-common`

Telemetry primitives (policy gate, `InvocationContext`, event schemas, sanitizers) live in `@microsoft/rayfin-tools-common/_internal/telemetry`.
That package is universal (Node.js + browser); it must not import Node.js built-ins.
The CLI provides the transport layer (OpenTelemetry SDK + Azure Monitor exporter).

### Conventions

- Telemetry is best-effort: never throw from telemetry code.
- Dynamic-import OpenTelemetry packages to avoid loading them when telemetry is disabled.
- Never collect parameter values, file paths, or user-identifiable data.
- Use `extractSafeParamNames()` to collect only flag/option names from `process.argv`.
- Opt-out via `RAYFIN_TELEMETRY_OPTOUT=1` (no CI auto-detection).
