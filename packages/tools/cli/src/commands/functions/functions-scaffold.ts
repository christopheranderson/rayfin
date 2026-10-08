import { constants, existsSync, readFileSync, readdirSync } from 'fs';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'path';

import { getPackageVersion } from '../../utils/version.js';
import { mergeRootFilesExclude } from '../../utils/vscode-config-utils.js';

/**
 * Returns `true` when the CLI is running inside the rayfin monorepo
 * (i.e. a `package.json` with `name === "rayfin-meta"` exists somewhere up
 * the directory tree).  Used to decide whether to use local `file:` paths or
 * published npm versions for `@microsoft/rayfin-*` packages.
 */
export async function isInDevelopmentMode(): Promise<boolean> {
  try {
    const currentDir = process.cwd();
    const parts = currentDir.split(/[\\/]/);

    for (let i = parts.length - 1; i >= 0; i--) {
      const pathToCheck = parts.slice(0, i + 1).join('/');
      try {
        const packageJsonPath = join(pathToCheck, 'package.json');
        await access(packageJsonPath, constants.F_OK);

        const packageContent = await readFile(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(packageContent);
        if (packageJson?.name === 'rayfin-meta') {
          return true;
        }
      } catch {
        // Continue searching
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolves absolute paths to each local `@microsoft/rayfin-*` package inside
 * the monorepo.  Only meaningful when {@link isInDevelopmentMode} returns
 * `true`.
 */
export async function getLocalPackagePaths(): Promise<{
  [key: string]: string;
}> {
  try {
    const currentDir = process.cwd();
    const parts = currentDir.split(/[\\/]/);

    for (let i = parts.length - 1; i >= 0; i--) {
      const pathToCheck = parts.slice(0, i + 1).join('/');
      try {
        const packageJsonPath = join(pathToCheck, 'package.json');
        await access(packageJsonPath, constants.F_OK);

        const packageContent = await readFile(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(packageContent);
        if (packageJson?.name === 'rayfin-meta') {
          return {
            '@microsoft/rayfin-core': join(
              pathToCheck,
              'packages/typescript-sdk/core'
            ),
            '@microsoft/rayfin-data': join(
              pathToCheck,
              'packages/typescript-sdk/data'
            ),
            '@microsoft/rayfin-client': join(
              pathToCheck,
              'packages/typescript-sdk/client'
            ),
            '@microsoft/rayfin-cli': join(
              pathToCheck,
              'packages/typescript-sdk/cli'
            ),
            '@microsoft/rayfin-functions': join(
              pathToCheck,
              'packages/typescript-sdk/functions'
            ),
            '@microsoft/fabric-user-data-functions': join(
              pathToCheck,
              '../fabric-appdev-function-extensions/worker-extensions/typescript-extension'
            ),
          };
        }
      } catch {
        // Continue searching
      }
    }
    throw new Error('Could not find rayfin workspace root');
  } catch {
    throw new Error('Could not determine local package paths');
  }
}

/**
 * Convert an OS-native path to the POSIX form TypeScript config files and
 * user-facing file listings both expect.
 */
function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Directory names never worth descending into when scanning for compilable
 * TypeScript sources — either not source (`node_modules`, `.git`) or already
 * compiler output (`dist`, `.temp`) that shouldn't count as project input.
 */
const COMPILE_SCAN_EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.temp',
]);

/**
 * Returns `true` if `dir` contains at least one `.ts`/`.tsx` file, recursing
 * into subdirectories but skipping `excludeAbsoluteDir` entirely (so the
 * about-to-be-scaffolded/re-scaffolded functions package's own sources never
 * count) along with the usual non-source directories.
 *
 * Used to guard the `rayfin/` composite project reference below — see
 * {@link resolveCompositeReference}.
 */
function hasCompilableSource(dir: string, excludeAbsoluteDir: string): boolean {
  if (resolve(dir) === resolve(excludeAbsoluteDir)) return false;

  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (COMPILE_SCAN_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (hasCompilableSource(full, excludeAbsoluteDir)) return true;
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the TypeScript project reference the scaffolded functions project
 * should declare, or `null` when no usable reference exists.
 *
 * The functions project references the `rayfin/` composite project so UDF code
 * can `import type` entity definitions out of `rayfin/data/`. That reference is
 * only safe to emit when the referenced project is actually loadable — a
 * dangling `references` entry makes `tsc --build` fail with TS5083 and takes
 * `rayfin functions init` down with it.
 *
 * Four things are checked:
 *  1. The functions package is nested under `rayfin/`. In a workspace layout
 *     the entity definitions live in the configured data package (e.g.
 *     `packages/data`), not in `rayfin/` — `rayfin/` holds only `rayfin.yml`
 *     and has nothing compilable to reference. Emitting `../../rayfin` there
 *     would point the reference at the wrong project and would not enable the
 *     `import type` it exists to enable, so it is omitted instead.
 *  2. `<projectRoot>/rayfin/tsconfig.json` exists.
 *  3. Its `extends` target (when relative) resolves. Workspace layouts move the
 *     root `tsconfig.json` under `packages/*`, which strands the
 *     `extends: "../tsconfig.json"` the stock `rayfin/tsconfig.json` ships with.
 *  4. `rayfin/` (outside the functions package itself) actually contains at
 *     least one compilable `.ts` file. `rayfin/tsconfig.json` is
 *     `include: ["**\/*"]` with no `files`, so on a fresh app with no
 *     `rayfin/data/` entities yet, referencing it gives `tsc --build` zero
 *     inputs and it fails with TS18003 ("No inputs were found") instead of
 *     compiling anything — see
 *     2253308.
 */
function resolveCompositeReference(
  projectRoot: string,
  functionsDir: string
): string | null {
  const rayfinDir = join(projectRoot, 'rayfin');
  const relativeToRayfin = relative(rayfinDir, functionsDir);
  const isNestedUnderRayfin =
    relativeToRayfin !== '' &&
    !relativeToRayfin.startsWith('..') &&
    !isAbsolute(relativeToRayfin);
  if (!isNestedUnderRayfin) return null;

  const rayfinTsconfigPath = join(rayfinDir, 'tsconfig.json');
  if (!existsSync(rayfinTsconfigPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(rayfinTsconfigPath, 'utf8'));
    const extendsValue: unknown = parsed?.extends;
    if (typeof extendsValue === 'string' && extendsValue.startsWith('.')) {
      const extendsTarget = resolve(
        join(projectRoot, 'rayfin'),
        extendsValue.endsWith('.json') ? extendsValue : `${extendsValue}.json`
      );
      if (!existsSync(extendsTarget)) return null;
    }
  } catch {
    return null;
  }

  if (!hasCompilableSource(rayfinDir, functionsDir)) return null;

  const relativePath = toPosix(
    relative(functionsDir, join(projectRoot, 'rayfin'))
  );
  return relativePath === '' ? '.' : relativePath;
}

/**
 * The `name` field the scaffold writes into every functions package.json.
 * Used both to write a fresh package and to recognize a prior scaffold on
 * re-run, so the two don't drift out of sync.
 */
const FUNCTIONS_PACKAGE_NAME = 'rayfin-functions';

/**
 * Refuse to scaffold on top of a directory that already contains someone
 * else's package.
 *
 * `resolveFunctionsTargetDir` blocks a resolved path equal to the project
 * root, but an operator can still point `--path` (or `services.functions.path`)
 * at an *existing, unrelated* workspace package — e.g. `packages/frontend`,
 * or any directory that happens to have a `package.json` already. Because
 * `scaffoldFunctionsDirectory` below writes `package.json` and `tsconfig.json`
 * unconditionally (even under `--force`, which only gates *whether* to
 * scaffold, not *what* it's allowed to overwrite), that silently clobbers the
 * other package's manifest.
 *
 * A directory with no `package.json` yet is always fine (fresh scaffold). A
 * directory whose `package.json` already has `name: "rayfin-functions"` is
 * also fine — that's a legitimate `--force` re-scaffold of a prior run. Any
 * other `package.json` — including one that fails to parse — is refused.
 */
function assertScaffoldTargetIsOwned(
  projectRoot: string,
  functionsDir: string
): void {
  const packageJsonPath = join(functionsDir, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  const relativeLabel = toPosix(relative(projectRoot, functionsDir));
  let existingName: unknown;
  try {
    existingName = JSON.parse(readFileSync(packageJsonPath, 'utf8'))?.name;
  } catch (error) {
    throw new Error(
      `Refusing to scaffold functions into '${relativeLabel}': its ` +
        `package.json exists but could not be parsed, so it is not safe to ` +
        `assume it is a prior functions scaffold. ${
          error instanceof Error ? error.message : String(error)
        }`
    );
  }

  if (existingName === FUNCTIONS_PACKAGE_NAME) return;

  throw new Error(
    `Refusing to scaffold functions into '${relativeLabel}': it already ` +
      `contains a package.json for '${String(existingName)}', not ` +
      `'${FUNCTIONS_PACKAGE_NAME}'. Scaffolding here would overwrite that ` +
      'package. Point --path (or services.functions.path) at an empty ' +
      'directory or one already owned by the functions scaffold.'
  );
}

/**
 * Scaffold a Rayfin functions package at `functionsDir`.
 *
 * `functionsDir` is resolved by the caller from
 * `services.functions.path` in `rayfin.yml` (defaulting to
 * `rayfin/functions`), so this works for both the single-package layout and
 * npm-workspace layouts that place the package at e.g. `packages/functions`.
 *
 * Creates:
 *  - `package.json`
 *  - `tsconfig.json`
 *  - `host.json`
 *  - `local.settings.json`
 *  - `src/function_app.ts`
 *  - `src/types.ts`
 *
 * Also merges `files.exclude` globs for the functions plumbing into the
 * **project root's** `.vscode/settings.json` (VS Code only honours settings at
 * the workspace root, so a nested `.vscode/settings.json` would never apply).
 */
export async function scaffoldFunctionsDirectory(
  projectRoot: string,
  functionsDir: string,
  createdFiles: string[],
  assetsDir: string
): Promise<void> {
  const version = getPackageVersion();
  if (version === 'Unknown') {
    throw new Error(
      'Could not read the CLI version from package.json, so the functions ' +
        'runtime cannot be pinned. Reinstall @microsoft/rayfin-cli.'
    );
  }

  const srcDir = join(functionsDir, 'src');
  const vscodeDir = join(functionsDir, '.vscode');

  assertScaffoldTargetIsOwned(projectRoot, functionsDir);

  // User-facing labels are relative to the project root so they read correctly
  // regardless of where the package actually lives.
  const label = (...parts: string[]): string =>
    toPosix(join(relative(projectRoot, functionsDir), ...parts));

  await mkdir(srcDir, { recursive: true });
  await mkdir(vscodeDir, { recursive: true });

  // package.json ----------------------------------------------------------
  // Match the CLI's release instead of resolving a moving npm dist-tag.
  const packageJson = {
    name: FUNCTIONS_PACKAGE_NAME,
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'dist/src/function_app.js',
    scripts: {
      // `tsc --build` (composite mode) is required because this project
      // declares a `references` to the sibling `rayfin/` composite
      // project. Without `--build`, tsc would treat the reference as
      // an opaque hint and fail to find the entity .d.ts files emitted
      // by the referenced project.
      build: 'tsc --build',
      'build:watch': 'tsc --build --watch',
      clean: 'rimraf dist',
    },
    dependencies: {
      '@microsoft/fabric-user-data-functions': version,
    },
    devDependencies: {
      typescript: '^5.8.0',
      rimraf: '^6.0.0',
    },
  };
  await writeFile(
    join(functionsDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf8'
  );
  createdFiles.push(label('package.json'));

  // tsconfig.json ---------------------------------------------------------
  //
  // Wired as a TypeScript project reference to the parent `rayfin/`
  // composite project (which already covers `data/`). This mirrors the
  // pattern the React app uses to consume entity types from `rayfin/data/*.ts`:
  //
  //   <project root>/tsconfig.json   →  references: [{ path: "./rayfin" }]
  //   <project root>/rayfin/tsconfig.json   →  composite: true, includes data/
  //
  // With the reference in place, UDF code can `import type` directly
  // from the entity files (e.g. `import type { GroceryItem } from
  // '../../data/GroceryItem.js';`). The `import type` keyword ensures
  // the import is erased at compile time, so the emitted
  // `dist/src/function_app.js` carries no `../../data/...` runtime
  // reference — important because `rayfin up functions deploy` zips
  // only the `functions/` folder. Entity types live as a single
  // source of truth in `rayfin/data/` and stay in sync across the
  // frontend, the function host, and any future consumer without
  // anyone re-typing the field shapes.
  //
  // `composite: true` and `declaration: true` are required by tsc for
  // any project that participates in a `references` graph (either as
  // the referrer or the referent).
  const compositeReference = resolveCompositeReference(
    projectRoot,
    functionsDir
  );
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: 'dist',
      rootDir: '.',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      sourceMap: true,
      composite: true,
      declaration: true,
    },
    include: ['src/**/*'],
    exclude: ['dist', 'node_modules'],
    ...(compositeReference
      ? { references: [{ path: compositeReference }] }
      : {}),
  };
  await writeFile(
    join(functionsDir, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2) + '\n',
    'utf8'
  );
  createdFiles.push(label('tsconfig.json'));

  if (!compositeReference) {
    console.warn(
      '⚠️  Skipped the TypeScript project reference to rayfin/: it is only ' +
        'emitted for a functions package nested under rayfin/ with a loadable ' +
        'rayfin/tsconfig.json.\n' +
        '   The functions project still builds; add a `references` entry ' +
        'manually if you want to `import type` entity definitions from your ' +
        'data package.'
    );
  }

  // host.json (Azure Functions host configuration) -------------------------
  const hostJson = {
    version: '2.0',
    logging: {
      applicationInsights: {
        samplingSettings: {
          isEnabled: true,
          excludedTypes: 'Request',
        },
      },
      logLevel: {
        default: 'Information',
      },
    },
    extensionBundle: {
      id: 'Microsoft.Azure.Functions.ExtensionBundle.Preview',
      version: '[4.49.0, 5.0.0)',
    },
    watchDirectories: ['dist'],
  };
  await writeFile(
    join(functionsDir, 'host.json'),
    JSON.stringify(hostJson, null, 2) + '\n',
    'utf8'
  );
  createdFiles.push(label('host.json'));

  // local.settings.json ---------------------------------------------------
  // `AZURE_FUNCTIONS_ENVIRONMENT: "Development"` is the platform-managed flag
  // the scaffolded `function_app.ts` reads to gate the local Rayfin client
  // bootstrap (publishable key + remote-data URL). Core Tools sets this
  // automatically when running `func start`, but seeding it here makes
  // direct-node launches (`node dist/...`) behave consistently. The deployed
  // Fabric UserDataFunction runtime overrides this to "Production".
  //
  // `rayfin dev functions apply` will later upsert `RAYFIN_API_URL`,
  // `RAYFIN_PUBLISHABLE_KEY`, and the Fabric workspace/item identifiers from
  // the active deployment. Those are NOT seeded here — they only make sense
  // once a deploy has happened.
  const localSettings = {
    IsEncrypted: false,
    Values: {
      FUNCTIONS_WORKER_RUNTIME: 'node',
      AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
      AzureWebJobsStorage: '',
      IsLocal: 'true',
    },
  };
  await writeFile(
    join(functionsDir, 'local.settings.json'),
    JSON.stringify(localSettings, null, 2) + '\n',
    'utf8'
  );
  createdFiles.push(label('local.settings.json'));

  // src/function_app.ts — loaded from assets template --------------------
  const functionsAssetsDir = join(assetsDir, 'functions');
  const functionAppTs = await readFile(
    join(functionsAssetsDir, 'function_app.ts.template'),
    'utf8'
  );
  await writeFile(join(srcDir, 'function_app.ts'), functionAppTs, 'utf8');
  createdFiles.push(label('src', 'function_app.ts'));

  // src/types.ts — loaded from assets template ----------------------------
  const typesTs = await readFile(
    join(functionsAssetsDir, 'types.ts.template'),
    'utf8'
  );
  await writeFile(join(srcDir, 'types.ts'), typesTs, 'utf8');
  createdFiles.push(label('src', 'types.ts'));

  // Hide host plumbing and generated files from the user's explorer ────────
  // These must live in the PROJECT ROOT's `.vscode/settings.json`
  try {
    const result = await mergeRootFilesExclude(projectRoot, {
      '**/host.json': true,
      '**/deploymetadata.json': true,
    });
    if (result.written) {
      createdFiles.push('.vscode/settings.json');
    }
  } catch (err) {
    console.warn(
      `⚠️  Could not update root .vscode/settings.json to hide functions plumbing: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // .vscode/launch.json ---------------------------------------------------
  // Attach config for the Node debugger when `rayfin dev functions apply`
  // starts `func start --inspect=9229`. The matching `runtimeArgs` are
  // injected by the CLI command, not by VS Code, so this is purely an
  // attach config — no `program` or `runtimeExecutable`.
  const vscodeLaunch = {
    version: '0.2.0',
    configurations: [
      {
        type: 'node',
        request: 'attach',
        name: 'Functions: Attach',
        port: 9229,
        restart: true,
        skipFiles: ['<node_internals>/**'],
        // Sources live in `dist/` relative to this folder; let VS Code resolve
        // them via the inspector's own protocol so source maps from
        // `tsc --sourceMap` map breakpoints back to `src/*.ts`.
        sourceMaps: true,
      },
    ],
  };
  await writeFile(
    join(vscodeDir, 'launch.json'),
    JSON.stringify(vscodeLaunch, null, 2) + '\n',
    'utf8'
  );
  createdFiles.push(label('.vscode', 'launch.json'));

  // .gitignore -------------------------------------------------------------
  // Keep generated/local-only files out of source control.
  const gitignoreContent = [
    'host.json',
    'local.settings.json',
    'deploymetadata.json',
    'bin/',
    'obj/',
    '',
  ].join('\n');
  await writeFile(join(functionsDir, '.gitignore'), gitignoreContent, 'utf8');
  createdFiles.push(label('.gitignore'));

  // ── Patch the enclosing rayfin/tsconfig.json ───────────────────────────
  //
  // `rayfin/tsconfig.json` (composite: true, include: ["**/*"]) must exclude
  // the functions sources — otherwise `tsc --build` considers them part of
  // that project and emits their JS into its outDir instead of the functions
  // package's own `dist/`.
  //
  // This only applies when the functions package actually lives *inside*
  // `rayfin/`. In a workspace layout (`packages/functions`) the sources are
  // already outside that project's `include`, so there is nothing to exclude
  // and rewriting an unrelated tsconfig would be wrong.
  const rayfinDir = join(projectRoot, 'rayfin');
  const relativeToRayfin = relative(rayfinDir, functionsDir);
  const isNestedUnderRayfin =
    relativeToRayfin !== '' &&
    !relativeToRayfin.startsWith('..') &&
    !isAbsolute(relativeToRayfin);

  if (!isNestedUnderRayfin) return;

  const excludeGlob = `${toPosix(relativeToRayfin)}/**/*`;
  const parentTsconfigPath = join(rayfinDir, 'tsconfig.json');
  try {
    const raw = await readFile(parentTsconfigPath, 'utf8');
    const parentTsconfig = JSON.parse(raw);
    const excludes: string[] = parentTsconfig.exclude ?? [];
    if (!excludes.includes(excludeGlob)) {
      excludes.push(excludeGlob);
      parentTsconfig.exclude = excludes;
      await writeFile(
        parentTsconfigPath,
        JSON.stringify(parentTsconfig, null, 2) + '\n',
        'utf8'
      );
    }
  } catch {
    // Best-effort — if the parent tsconfig is missing or unreadable,
    // the scaffold still succeeds. The user can add the exclude manually.
  }
}
