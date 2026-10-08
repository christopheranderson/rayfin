import { constants, existsSync } from 'fs';
import {
  mkdir,
  writeFile,
  access,
  copyFile,
  readFile,
  stat,
} from 'fs/promises';
import { resolve, join } from 'path';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  applyBaseApiUrlOverride,
  applyWorkspaceUriOverrides,
} from '@microsoft/rayfin-tools-common/_internal';
import {
  DatabaseDialect,
  parseRayfinYaml,
  validateServiceDependencies,
  type Dialect,
} from '@microsoft/rayfin-tools-common/_internal/config';
import type { ProjectOriginWriter } from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import {
  flattenManifestEntries,
  isGitUrl,
  isValidProjectName,
  parseManifest,
  visibleTemplates,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import type {
  ResolvedTemplate,
  TemplateManifest,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import { Command, Option } from 'commander';
import figlet from 'figlet';
import inquirer from 'inquirer';
import { parse, stringify } from 'yaml';

import { CliHandledError, ScaffoldCancelledError } from '../errors.js';
import { createCliProjectTelemetryService } from '../local-services/index.js';
import { RayfinItemManager } from '../services/fabric/rayfin-item.js';
import { getCurrentContext } from '../telemetry/context-store.js';
import {
  AuthMethod,
  RayfinConfig,
  StaticHostingConfig,
} from '../types/config.js';
import { preSeedDeploymentEnvFile } from '../utils/env-fabric-utils.js';
import { upsertEnvVariables } from '../utils/env-file-utils.js';
import { createCliFeatureFlags } from '../utils/feature-flags.js';
import { mergeGitignore } from '../utils/gitignore-merge.js';
import { hydrateDeploymentFromFabric } from '../utils/hydrate-deployment.js';
import {
  createAuthConfig,
  AuthOptions,
} from '../utils/init-auth-settings-helper.js';
import { createFunctionsAuthConfig } from '../utils/init-functions-settings-helper.js';
export type {
  AuthOptions,
  PasswordlessOptions,
} from '../utils/init-auth-settings-helper.js';
import {
  isInteractive,
  modeLog,
  modeError,
  modeWarn,
  emitJson,
  emitJsonError,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../utils/output-mode.js';
import { normalizePath } from '../utils/path-utils.js';
import { spawnSafe } from '../utils/platform-utils.js';
import {
  acquireFabricTokenForLookup,
  resolveWorkspaceIdByName,
} from '../utils/resolve-workspace-name.js';
import {
  type ScaffoldResult,
  assertTargetConflictOrThrow,
  cleanupPartialScaffold,
  instantiateAndReport,
  isInPlaceDirectory,
  printNextStepsBanner,
  resolveProjectName,
  resolveScaffoldTarget,
  runScaffoldPipeline,
  slugifyDirectoryArg,
  wipeTargetDirectory,
} from '../utils/scaffold-pipeline.js';
import { selectTemplateEntry } from '../utils/template-entry-selector.js';
import {
  discoverRegistryEntries,
  type RegistryDiscoveryResult,
} from '../utils/template-registry.js';
import {
  discoverBundledTemplates,
  selectBundledTemplate,
} from '../utils/template-scaffold.js';
import { RAYFIN_COMPILED_DIR } from '../utils/typescript-compiler.js';

import { aiFilesCommand } from './ai-files/ai-files.js';
import { installAgentFilesAfterScaffold } from './ai-files/install-after-scaffold.js';
import {
  isInDevelopmentMode,
  getLocalPackagePaths,
  scaffoldFunctionsDirectory,
} from './functions/functions-scaffold.js';
import { handleBundledTemplate } from './init-bundled-template.js';
import { handleExternalTemplate } from './init-external-template.js';
import {
  buildRegistryCloneUrl,
  isFabricTargetingFlagSet,
  planServiceDirectoryScaffolding,
  safeTemplateNameForTelemetry,
  selectTemplateSource,
  validateInitFlags,
} from './init-helpers.js';
export { isLocalPath } from './init-helpers.js';

// Re-export so existing consumers (e.g. functions-init) can import from either location.
export {
  isInDevelopmentMode,
  getLocalPackagePaths,
  scaffoldFunctionsDirectory,
};

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface InitOptions {
  template?: string;
  templateName?: string;
  listTemplates?: boolean;
  fromTemplate?: boolean;
  projectName?: string;
  dialect?: string;
  skipInstall?: boolean;
  skipRayfinPackageInstall?: boolean;
  services?: string;
  authMethods?: string;
  staticHosting?: boolean;
  overwrite?: boolean;
  yes?: boolean;
  workspace?: string;
  workspaceId?: string;
  workspaceUri?: string;
  baseApiUrl?: string;
  itemId?: string;
}

/** Map an internal registrySource value to a human/API-facing label. Exported for testing. */
export function registrySourceLabel(
  registrySource: string | undefined
): string {
  if (!registrySource || registrySource === 'bundled') return 'built-in';
  return registrySource;
}

/** Load registry entries, capturing failures as warnings. */
async function tryDiscoverRegistryEntries(
  mode: OutputMode,
  configDir?: string
): Promise<RegistryDiscoveryResult> {
  try {
    return await discoverRegistryEntries(configDir);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown registry load error';
    modeWarn(mode, `⚠️  Could not load template registry: ${message}`);
    return { entries: [], warnings: [message] };
  }
}

interface ProjectAnswers {
  projectName: string;
  services: string[];
  authMethods?: string[];
  enableEmailVerification?: boolean;
  dialect?: Dialect;
  overwrite?: boolean;
}

function createSlug(name: string): string {
  // Bound input length before applying regex replacements to avoid the
  // polynomial-backtracking risk CodeQL flags on adversarial inputs with
  // long runs of non-alphanumeric chars or hyphens. Project names beyond
  // 256 chars are well outside any real use case.
  const bounded = name.length > 256 ? name.slice(0, 256) : name;
  return bounded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function checkPackageJsonExists(directory: string): Promise<boolean> {
  try {
    const packageJsonPath = join(directory, 'package.json');
    await access(packageJsonPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runNpmInstall(
  mode: OutputMode,
  directory: string,
  command: string[],
  description: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    modeLog(
      mode,
      `🚀 Running npm command for ${description}:`,
      'npm',
      command.join(' ')
    );
    // Use spawnSafe to pick the platform-correct command name (`npm.cmd`
    // on Windows) and avoid shell: true so paths with spaces are not
    // word-split.
    const npmProcess = spawnSafe('npm', command, {
      cwd: directory,
      stdio: 'inherit',
    });

    npmProcess.on('close', (code) => {
      modeLog(
        mode,
        `✅ ${description} installation completed with exit code: ${code}`
      );
      if (code !== 0) {
        reject(
          new Error(`Failed to install ${description}. Exit code: ${code}`)
        );
        return;
      }
      resolve();
    });

    npmProcess.on('error', (err) => {
      modeError(mode, `❌ Error spawning npm for ${description}:`, err.message);
      reject(
        new Error(`Failed to spawn npm for ${description}: ${err.message}`)
      );
    });
  });
}

async function installLocalPackages(
  mode: OutputMode,
  directory: string,
  packagePaths: { [key: string]: string }
): Promise<void> {
  const dependencies = [
    `file:${packagePaths['@microsoft/rayfin-core']}`,
    `file:${packagePaths['@microsoft/rayfin-data']}`,
    `file:${packagePaths['@microsoft/rayfin-client']}`,
  ];
  const devDependencies = [`file:${packagePaths['@microsoft/rayfin-cli']}`];

  modeLog(
    mode,
    '📦 Installing @microsoft/rayfin-* packages from local workspace...'
  );
  modeLog(mode, '🔍 Target directory:', directory);
  modeLog(mode, '📋 Package paths:');
  Object.entries(packagePaths).forEach(([name, path]) => {
    modeLog(mode, `   ${name} -> ${path}`);
  });
  modeLog(mode, '🔗 Dependencies to install:', dependencies);
  modeLog(mode, '🛠️  Dev dependencies to install:', devDependencies);

  // Install regular dependencies
  const installCommand = ['install', '--save', ...dependencies];
  await runNpmInstall(mode, directory, installCommand, 'regular dependencies');

  // Install dev dependencies
  const devInstallCommand = ['install', '--save-dev', ...devDependencies];
  await runNpmInstall(mode, directory, devInstallCommand, 'dev dependencies');

  modeLog(mode, '🎉 All local packages installed successfully!');
}

async function installRayfinPackages(
  mode: OutputMode,
  directory: string
): Promise<void> {
  const dependencies = [
    '@microsoft/rayfin-core',
    '@microsoft/rayfin-data',
    '@microsoft/rayfin-client',
  ];
  const devDependencies = ['@microsoft/rayfin-cli'];

  modeLog(
    mode,
    '📦 Installing @microsoft/rayfin-* packages from npm registry...'
  );
  modeLog(mode, '🔍 Target directory:', directory);
  modeLog(mode, '🔗 Dependencies to install:', dependencies);
  modeLog(mode, '🛠️  Dev dependencies to install:', devDependencies);

  // Install regular dependencies
  const installCommand = ['install', '--save', ...dependencies];
  await runNpmInstall(mode, directory, installCommand, 'regular dependencies');

  // Install dev dependencies
  const devInstallCommand = ['install', '--save-dev', ...devDependencies];
  await runNpmInstall(mode, directory, devInstallCommand, 'dev dependencies');

  modeLog(mode, '🎉 All registry packages installed successfully!');
}

/**
 * Apply the minimum set of identity edits a `rayfin init --from-template`
 * sync is allowed to make to a pre-existing `rayfin.yml`.
 *
 * The previous behavior (`updateRayfinYml`) reconstructed the `services`
 * block from `createAuthConfig(...)` defaults whenever the user passed a
 * `--project-name` that differed from the template's manifest name —
 * which `create-rayfin` and the portal-emitted `npm init` command always
 * do. The result was that external templates with a deliberately minimal
 * `auth: { enabled: true }` came out the other side with default
 * `customClaims`, `scopes`, `password`, `allowedRedirectUris`,
 * `staticHosting`, and `functions` blocks bolted on. That violates the
 * "preserves the existing rayfin.yml exactly as-is" contract under the
 * Force Overwrite Option requirement.
 *
 * This helper preserves the template author's settings and arbitrary
 * top-level keys. It only writes:
 *   - `name` and `id` (slugified) when `projectName` differs from
 *     `existingConfig.name`. The user opted into the rename via
 *     `--project-name`, so honoring it is the whole point of the call.
 *   - `services.data.dialect` when the user passed `--dialect` AND the
 *     template author shipped a `services.data` block (enabled OR
 *     disabled) whose dialect differs. Honoring the flag on a disabled
 *     block matters: a user may scaffold against a template with
 *     `data: { enabled: false, dialect: postgresql }` while passing
 *     `--dialect mssql`, intending to flip data on later. Without this
 *     edit they'd be left with a stale postgresql dialect that fails at
 *     publish-time against backends that don't support it. We only
 *     intervene when the block already exists — synthesizing a brand
 *     new `services.data` block from a flag is still out of scope; the
 *     call site emits a `--dialect was ignored` warning in that case.
 *   - Service `enabled` fields when the user explicitly passed `--services`.
 *     Template-enabled services remain enabled; requested services are added
 *     or enabled without replacing the template's authored settings.
 *
 * Returns `null` when no edit is required so the caller can skip the
 * write entirely (preserves byte-for-byte identity, including any
 * whitespace or comment formatting `yaml.parse` + `yaml.stringify` would
 * have round-tripped away).
 */
/**
 * True when the template author shipped an enabled `services.data` block
 * in their `rayfin.yml`. The "enabled" check matters: a template may
 * include `services.data` purely to opt out
 * (`services: { data: { enabled: false } }`). The from-scratch warn
 * site uses this to surface that `--dialect` won't be persisted into the
 * rayfin.yml that's about to be written.
 */
export function isDataServiceEnabled(
  config: Pick<RayfinConfig, 'services'>
): boolean {
  return config.services?.data?.enabled === true;
}

/**
 * True when the template author shipped a `services.data` block in
 * their `rayfin.yml`, regardless of `enabled`. Used by the template-path
 * helpers to distinguish "no data block at all" (where `--dialect`
 * has nowhere to land and we warn) from "data block exists but disabled"
 * (where we honor `--dialect` so a later flip to `enabled: true` doesn't
 * inherit a stale dialect — e.g. postgresql against a Fabric backend
 * that doesn't support it).
 */
export function hasDataServiceBlock(
  config: Pick<RayfinConfig, 'services'>
): boolean {
  return config.services?.data !== undefined;
}

function assertStorageDataDependency(services: readonly string[]): void {
  const [error] = validateServiceDependencies({
    dataEnabled: services.includes('data'),
    storageEnabled: services.includes('storage'),
  });
  if (error) {
    throw new Error(error.message);
  }
}

function validateStorageDataDependency(
  mode: OutputMode,
  services: readonly string[]
): void {
  try {
    assertStorageDataDependency(services);
  } catch (error) {
    const message = (error as Error).message;
    const hint = 'Include both "data" and "storage" in --services.';
    if (mode === 'json') {
      emitJsonError(mode, message, { hint });
    }
    modeError(mode, `❌ ${message}`);
    modeError(mode, `   ${hint}`);
    throw new CliHandledError(error);
  }
}

export function applyRayfinYmlIdentityEdits(
  existingConfig: RayfinConfig,
  projectName: string,
  dialect?: Dialect,
  servicesToEnable?: string[]
): string | null {
  const effectiveServices = [
    ...(existingConfig.services?.data?.enabled === true ? ['data'] : []),
    ...(existingConfig.services?.storage?.enabled === true ? ['storage'] : []),
    ...(servicesToEnable ?? []),
  ];
  assertStorageDataDependency(effectiveServices);

  const functionsAuth = servicesToEnable?.includes('functions')
    ? createFunctionsAuthConfig(existingConfig.services?.functions)
    : undefined;
  const renaming = !!projectName && projectName !== existingConfig.name;
  // Attempt a dialect rewrite when the template author has a
  // `services.data` block at all (enabled or disabled). Updating the
  // dialect on a disabled block is intentional: it lets a user flip
  // `enabled: true` later without inheriting a stale dialect they never
  // chose. Synthesizing a brand-new `services.data` block from a flag
  // is still out of scope — the call site warns when the block is
  // entirely missing so the user knows the flag had no landing place.
  const dialectChange =
    !!dialect &&
    hasDataServiceBlock(existingConfig) &&
    existingConfig.services!.data!.dialect !== dialect;
  const configurableServices = [
    'auth',
    'data',
    'storage',
    'functions',
  ] as const;
  const serviceSelectionChange =
    servicesToEnable !== undefined &&
    configurableServices.some(
      (service) =>
        servicesToEnable.includes(service) &&
        existingConfig.services?.[service]?.enabled !== true
    );

  if (!renaming && !dialectChange && !serviceSelectionChange) {
    return null;
  }

  const updated = structuredClone(existingConfig) as RayfinConfig;
  if (renaming) {
    updated.name = projectName;
    updated.id = createSlug(projectName);
  }
  if (dialectChange) {
    updated.services!.data!.dialect = dialect;
  }
  if (servicesToEnable !== undefined) {
    updated.services = { ...updated.services };
    const requested = new Set(servicesToEnable);
    if (requested.has('auth')) {
      updated.services.auth = {
        ...updated.services.auth,
        enabled: true,
      };
    }
    if (requested.has('data')) {
      updated.services.data = {
        ...updated.services.data,
        enabled: true,
      };
    }
    if (requested.has('storage')) {
      updated.services.storage = {
        ...(updated.services.storage ?? {}),
        enabled: true,
      };
    }
    if (functionsAuth && existingConfig.services?.functions?.enabled !== true) {
      updated.services.functions = {
        ...(updated.services.functions ?? {}),
        enabled: true,
        auth: functionsAuth,
      };
    }
  }

  return stringify(updated, {
    lineWidth: 0,
    doubleQuotedAsJSON: false,
  });
}

export function createRayfinYml(
  projectName: string,
  services: string[],
  emailEnabled = false,
  dialect?: Dialect,
  authOptions?: AuthOptions,
  staticHostingConfig?: StaticHostingConfig
): string {
  assertStorageDataDependency(services);
  const slug = createSlug(projectName);

  // Data is enabled only when explicitly selected. Storage requires Data, but
  // the initializer rejects an invalid selection instead of enabling it
  // implicitly.
  const dataConfig: any = {
    enabled: services.includes('data'),
  };

  // Only include dialect when data service is enabled
  if (services.includes('data') && dialect) {
    dataConfig.dialect = dialect;
  }

  const config: RayfinConfig = {
    id: slug,
    name: projectName,
    version: '1.0.11',
    services: {
      auth: createAuthConfig(
        services.includes('auth'),
        emailEnabled,
        authOptions
      ),
      data: dataConfig,
      ...(services.includes('storage') ? { storage: { enabled: true } } : {}),
      // A new app is protected from the moment it exists. Authoring the posture
      // here rather than inferring it at deploy time is deliberate: `rayfin up`
      // cannot tell a brand-new project from a clean checkout of a live one,
      // because the deployment registry is gitignored. Defaulted rather than
      // only set on the built-in block, so a caller-supplied one cannot scaffold
      // a project with no posture.
      staticHosting: {
        ...(staticHostingConfig ?? {
          enabled: false,
          folder: 'dist',
          indexDocument: 'index.html',
        }),
        assetAccess: staticHostingConfig?.assetAccess ?? 'protected',
      },
      // Only emit a `functions` block when the user explicitly opted in.
      // Absence is semantically equivalent to `enabled: false`.
      ...(services.includes('functions')
        ? {
            functions: {
              enabled: true,
              auth: createFunctionsAuthConfig(),
            },
          }
        : {}),
    },
  };

  return stringify(config, {
    lineWidth: 0,
    doubleQuotedAsJSON: false,
  });
}

function parseCommaSeparated(
  mode: OutputMode,
  value: string,
  validValues: string[],
  flagName: string
): string[] {
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = items.filter((i) => !validValues.includes(i));
  if (invalid.length > 0) {
    modeError(mode, `❌ Invalid ${flagName} value(s): ${invalid.join(', ')}`);
    modeError(mode, `   Valid values: ${validValues.join(', ')}`);
    throw new CliHandledError(
      new Error(`Invalid ${flagName} value(s): ${invalid.join(', ')}`)
    );
  }
  return items;
}

/**
 * Handle scaffolding from a local template directory.
 *
 * @returns the completed scaffold target path.
 * @throws {@link ScaffoldCancelledError} - on user cancellation. Triggers
 *   per `openspec/specs/rayfin-cli-init/spec.md`:
 *   - declined overwrite prompt against a non-empty target (named or in-place)
 *   - non-interactive run without `--overwrite` against a non-empty target
 *   Wrappers map this to exit code 2 + Canceled telemetry.
 * @throws {@link CliHandledError} - on hard failure (path validation, manifest
 *   parse error, entry selection error, scaffold failure). Handler emitted
 *   a friendly message; wrappers must not re-print.
 */
async function handleLocalTemplate(
  templatePath: string,
  directory: string,
  mode: OutputMode,
  options: {
    projectName?: string;
    services?: string;
    interactive?: boolean;
    templateName?: string;
    overwrite?: boolean;
    dialect?: string;
    workspaceId?: string;
    itemId?: string;
    baseApiUrl?: string;
    skipInstall?: boolean;
    useProjectNameAsDirectory?: boolean;
  }
): Promise<ScaffoldResult> {
  const currentDirectory = process.cwd();
  const inputInPlace = isInPlaceDirectory(directory);
  const targetDirectoryForName = resolve(currentDirectory, directory);
  const resolvedTemplatePath = resolve(currentDirectory, templatePath);
  const nonInteractive = !(options.interactive ?? false);

  // Verify path exists and is a directory
  let pathStat;
  try {
    pathStat = await stat(resolvedTemplatePath);
  } catch {
    modeError(mode, `❌ Template path does not exist: ${templatePath}`);
    throw new CliHandledError(
      new Error(`Template path does not exist: ${templatePath}`)
    );
  }
  if (!pathStat.isDirectory()) {
    modeError(mode, `❌ Template path is not a directory: ${templatePath}`);
    throw new CliHandledError(
      new Error(`Template path is not a directory: ${templatePath}`)
    );
  }

  // Resolve project name BEFORE disk work so validation errors surface
  // cleanly (matches bundled and external flow patterns).
  let resolvedProjectName: string;
  try {
    resolvedProjectName = await resolveProjectName({
      explicitProjectName: options.projectName,
      directory: targetDirectoryForName,
      inPlace: inputInPlace,
      nonInteractive,
    });
  } catch (err) {
    modeError(mode, err instanceof Error ? err.message : String(err));
    throw new CliHandledError(err);
  }

  modeLog(mode, `🔖 Project name: ${resolvedProjectName}`);

  modeLog(mode, '📦 Scaffolding from local template...\n');

  const {
    inPlace,
    directoryForFilesystem,
    targetPath: targetDirectory,
  } = resolveScaffoldTarget({
    directory,
    projectName: resolvedProjectName,
    inputInPlace,
    useProjectNameAsDirectory: options.useProjectNameAsDirectory,
  });
  const targetExisted = existsSync(targetDirectory);

  // Match the bundled/external conflict-prompt UX: if the target directory
  // exists and isn't empty, prompt (or use --overwrite in non-interactive).
  // For in-place scaffolds (`isInPlaceDirectory(directory)`) we still prompt —
  // the spec requires exit code 2 on declined-overwrite for ANY non-empty
  // target, including the cwd. Wipe is suppressed for in-place below;
  // per-file collision resolution handles overlap with existing files.
  let userConsentedOverwrite = false;
  let targetWasEmpty = false;
  if (targetExisted) {
    const result = await assertTargetConflictOrThrow(
      targetDirectory,
      { nonInteractive, overwrite: options.overwrite },
      mode
    );
    userConsentedOverwrite = result.consentedOverwrite;
    targetWasEmpty = result.targetWasEmpty;
  }

  let manifest: TemplateManifest;
  let template: ResolvedTemplate;
  try {
    manifest = await parseManifest(resolvedTemplatePath);
    template = await selectTemplateEntry(manifest, resolvedTemplatePath, {
      interactive: options.interactive ?? false,
      templateName: options.templateName,
      onPathFallback: (message) => modeWarn(mode, message),
    });
  } catch (err) {
    // Mirror the external flow: pre-scaffold validation failures emit a
    // friendly modeError and re-throw as CliHandledError so wrappers
    // don't double-print the message.
    modeError(
      mode,
      `❌ Failed to load local template: ${err instanceof Error ? err.message : String(err)}`
    );
    throw new CliHandledError(err);
  }

  modeLog(
    mode,
    `✅ Found template: ${manifest.metadata.displayName ?? manifest.metadata.name}${manifest.metadata.description ? ` — ${manifest.metadata.description}` : ''}`
  );

  // Mirror the external flow's leaf-selection feedback: when the source
  // resolves more than one leaf, surface which leaf was actually chosen so a
  // grouped or --template-name run doesn't leave the user guessing.
  const flattenedLocalEntries = flattenManifestEntries(manifest.entries);
  if (flattenedLocalEntries.length > 1) {
    modeLog(
      mode,
      `📦 Selected template: ${template.manifest.metadata.displayName ?? template.manifest.metadata.name}`
    );
  }

  const presets: Record<string, unknown> = {
    projectName: resolvedProjectName,
  };

  let scaffoldError: Error | undefined;
  try {
    // Defer wipe until after parseManifest/selectTemplateEntry succeeded,
    // so a manifest parse failure on a non-empty user dir preserves their
    // pre-existing data. (parseManifest already ran above before this try
    // block, so reaching here means the source is validated.) Skip wipe
    // for in-place (cwd) targets to avoid catastrophically deleting the
    // user's working directory — per-file collision resolution still
    // handles overlap with existing files via the overwrite flag.
    if (userConsentedOverwrite && !inPlace) {
      wipeTargetDirectory(targetDirectory, mode);
    }
    await mkdir(targetDirectory, { recursive: true });

    await runScaffoldPipeline(
      {
        targetPath: targetDirectory,
        projectName: resolvedProjectName,
        services: options.services,
        dialect: options.dialect,
        workspaceId: options.workspaceId,
        itemId: options.itemId,
        baseApiUrl: options.baseApiUrl,
        skipInstall: options.skipInstall,
        preserveTemplatePackageVersions: true,
        allowInteractiveFabricAuth: options.interactive === true,
      },
      async () => {
        await instantiateAndReport(
          template,
          {
            targetDir: targetDirectory,
            presets,
            overwrite: userConsentedOverwrite || options.overwrite,
          },
          mode
        );
      },
      mode
    );

    printNextStepsBanner(mode, directoryForFilesystem, inPlace);
  } catch (error) {
    modeError(
      mode,
      `❌ Failed to scaffold template: ${error instanceof Error ? error.message : String(error)}`
    );

    const shouldCleanupPartial =
      !inPlace && (!targetExisted || targetWasEmpty || userConsentedOverwrite);
    await cleanupPartialScaffold(targetDirectory, shouldCleanupPartial, mode);

    scaffoldError = error instanceof Error ? error : new Error(String(error));
  }

  if (scaffoldError) {
    // Preserve the original error so telemetry captures the actual
    // failure (e.g. EACCES, ENOSPC, template-engine validation error).
    throw new CliHandledError(scaffoldError);
  }

  return { targetPath: targetDirectory };
}

const BASE_API_URL_HELP =
  'Fabric REST API base URL override. Accepts a bare origin (https://api.fabric.microsoft.com), a fully qualified base URL (https://api.fabric.microsoft.com/v1), or a non-Fabric origin with a path prefix for routing through a proxy (https://my-proxy.example.com/cli-proxy/fabric/<conn_id>). Applied for this run and persisted into rayfin/.env so subsequent rayfin commands inherit it.';

function createBaseApiUrlOption(): Option {
  return new Option('--base-api-url <url>', BASE_API_URL_HELP).hideHelp();
}

export const init = (
  options: {
    createProjectSemantics?: boolean;
    /** Lazy because Commander creates the telemetry context in `preAction`. */
    getProjectOriginId?: () => string | undefined;
    /** Override used by hosts/tests; defaults to the CLI project writer. */
    projectOriginWriter?: ProjectOriginWriter;
  } = {}
): Command => {
  const projectOriginWriter = options.getProjectOriginId
    ? (options.projectOriginWriter ?? createCliProjectTelemetryService())
    : undefined;
  const directoryDescription = options.createProjectSemantics
    ? 'Child project directory to create. When omitted, the resolved project name is used as the child directory; an explicit in-place form (".", "./", or any path resolving to the current directory) scaffolds into the current directory. Bare names with whitespace are slugified for the folder ("My App" → my-app/); pass "./My App" to keep the spaces.'
    : 'Directory to create the project in (when omitted, the current directory is used). Doubles as the default project name. Bare names with whitespace are slugified for the folder ("My App" → my-app/); pass "./My App" to keep the spaces.';
  const projectNameDescription = options.createProjectSemantics
    ? 'Override the project name and update rayfin.yml. When [directory] is omitted, this also supplies the child directory name.'
    : 'Override the project name and update rayfin.yml without changing the directory.';

  return (
    new Command('init')
      .description('Create a new Rayfin project')
      .argument('[directory]', directoryDescription)
      .addOption(new Option('--project-name <name>', projectNameDescription))
      .addOption(
        new Option(
          '-t, --template <uri>',
          'Template name or URL to create project from'
        )
      )
      .addOption(
        new Option(
          '--template-name <name>',
          'Pick one template from a multi-template source non-interactively'
        )
      )
      .addOption(
        new Option(
          '-l, --list-templates',
          'List all available project templates'
        )
      )
      // Hidden flag used by automation (e.g., create-rayfin) to overwrite prompted files while preserving rayfin.yml
      .addOption(new Option('--from-template').hideHelp())
      // Hidden flag used by automation to specify database dialect
      .addOption(new Option('--dialect <dialect>', 'Database dialect'))
      // Hidden flag used by automation/tests to skip all package installation.
      .addOption(new Option('--skip-install').hideHelp())
      // Hidden child-sync flag for external/local templates that must keep authored package versions.
      .addOption(new Option('--skip-rayfin-package-install').hideHelp())
      .addOption(
        new Option(
          '--services <list>',
          'Comma-separated services to enable (auth,data,functions)'
        )
      )
      .addOption(
        new Option(
          '--auth-methods <list>',
          'Comma-separated auth methods (fabric)'
        )
      )
      .option(
        '--static-hosting',
        'Scaffold a static frontend; enabled by default',
        true
      )
      .option('--overwrite', 'Overwrite existing configuration files', false)
      .option(
        '-w, --workspace <name>',
        'Enter a valid Fabric workspace name. Check in Fabric portal if unsure'
      )
      .option(
        '--workspace-id <id>',
        'Provide a Fabric workspace ID. You cannot use both --workspace and --workspace-id together'
      )
      .addOption(
        new Option(
          '--workspace-uri <uri>',
          'Fabric portal workspace URL to pre-seed workspace ID and target environment'
        ).hideHelp()
      )
      .addOption(createBaseApiUrlOption())
      .option('--item-id <id>', 'Provide a Fabric App Item ID')
      .action(async function (
        this: Command,
        directoryArg: string | undefined,
        _options: InitOptions
      ) {
        const mode = resolveOutputMode(resolveRootOutputFlags(this));
        try {
          const globalOpts = this.optsWithGlobals();
          const interactive = isInteractive({
            yes: globalOpts.yes ?? _options.yes,
          });
          const fromTemplate = Boolean(_options.fromTemplate);
          const providedProjectName = _options.projectName;
          // The `[directory]` argument carries no Commander default, so an
          // omitted positional arrives as `undefined` while an explicit value
          // (even an in-place `.`) arrives verbatim. Normalize to `.` for all
          // downstream use; `directoryWasProvided` captures the distinction the
          // default would otherwise erase.
          const directoryWasProvided = directoryArg !== undefined;
          const directory = directoryArg ?? '.';

          // Create-project "nest under the project name" semantics apply only
          // when the positional directory is OMITTED (the bare
          // `npm create @microsoft/rayfin` flow). An explicit directory - even
          // an in-place `.` (Fabric portal: `create-rayfin . --project-name`) -
          // is honored literally. `createProjectSemantics` is the single source
          // of truth, set by the create-rayfin wrapper (see
          // packages/tools/create-rayfin/src/index.ts) at command-build time.
          const useProjectNameAsDirectory =
            options.createProjectSemantics === true && !directoryWasProvided;

          // ── Pure flag validation (mutual exclusion + dialect normalization)
          const flagValidation = validateInitFlags({
            template: _options.template,
            templateName: _options.templateName,
            workspace: _options.workspace,
            workspaceUri: _options.workspaceUri,
            workspaceId: _options.workspaceId,
            baseApiUrl: _options.baseApiUrl,
            dialect: _options.dialect,
          });
          for (const warning of flagValidation.warnings) {
            modeWarn(mode, `⚠️  ${warning}`);
          }
          if (flagValidation.errors.length > 0) {
            modeError(mode, `❌ ${flagValidation.errors[0]}`);
            process.exit(1);
          }
          if (flagValidation.normalizedDialect !== undefined) {
            _options.dialect = flagValidation.normalizedDialect;
          }

          // ── Apply --workspace-uri side effects (env mutation) ──────────
          // Capture the URI-derived API+portal URLs so we can persist them to
          // rayfin/.env after scaffolding (so subsequent commands inherit them).
          let workspaceApiUrl: string | undefined;
          let workspacePortalUrl: string | undefined;
          if (_options.workspaceUri) {
            try {
              const parsed = applyWorkspaceUriOverrides(_options.workspaceUri);
              workspaceApiUrl = parsed.fabricApiBaseUrl;
              workspacePortalUrl = parsed.fabricPortalUrl;
              if (parsed.isMyWorkspace) {
                modeLog(
                  mode,
                  `🌐 Parsed --workspace-uri → environment='${parsed.environment}', workspace='My workspace'`
                );
              } else {
                _options.workspaceId = parsed.workspaceId;
                modeLog(
                  mode,
                  `🌐 Parsed --workspace-uri → environment='${parsed.environment}', workspace=${parsed.workspaceId}`
                );
              }
            } catch (err) {
              modeError(mode, `❌ ${(err as Error).message}`);
              process.exit(1);
            }
          }

          // ── Apply --base-api-url side effect (env mutation) ────────────
          // The override is captured (normalized form) so we can persist it to
          // rayfin/.env after scaffolding so subsequent commands inherit it.
          // When the API host follows the *.fabric.microsoft.com `<env>api`
          // convention we also capture the derived portal URL so the
          // deployment registry's fabricDeepLink and RAYFIN_PUBLIC_PORTAL_URL
          // target the same Fabric environment as the API.
          let normalizedBaseApiUrl: string | undefined;
          let baseApiPortalUrl: string | undefined;
          if (_options.baseApiUrl) {
            try {
              const applied = applyBaseApiUrlOverride(_options.baseApiUrl);
              normalizedBaseApiUrl = applied.fabricApiBaseUrl;
              baseApiPortalUrl = applied.fabricPortalUrl;
              modeLog(
                mode,
                `🌐 Using Fabric API base URL: ${normalizedBaseApiUrl}`
              );
              if (baseApiPortalUrl) {
                modeLog(
                  mode,
                  `🌐 Derived Fabric portal URL: ${baseApiPortalUrl}`
                );
              }
            } catch (err) {
              modeError(mode, `❌ ${(err as Error).message}`);
              process.exit(1);
            }
          }

          /**
           * Build the Fabric env-var map to persist into rayfin/.env so subsequent
           * `rayfin dev`/`rayfin up` invocations inherit the same Fabric environment
           * the user picked at init time. Empty when neither flag was provided.
           *
           * --base-api-url wins over --workspace-uri for RAYFIN_FABRIC_API_URL
           * (matches the runtime override order: applyBaseApiUrlOverride runs
           * after applyWorkspaceUriOverrides above).
           */
          function buildFabricEnvOverrides(): Array<{
            key: string;
            value: string;
          }> {
            const vars: Array<{ key: string; value: string }> = [];
            if (options.createProjectSemantics && _options.workspace) {
              vars.push({
                key: 'RAYFIN_WORKSPACE_NAME',
                value: _options.workspace.trim(),
              });
            }
            const apiUrl = normalizedBaseApiUrl ?? workspaceApiUrl;
            if (apiUrl) {
              vars.push({ key: 'RAYFIN_FABRIC_API_URL', value: apiUrl });
            }
            // --base-api-url wins over --workspace-uri for the portal URL too,
            // mirroring the API-URL precedence above. (init enforces that the
            // two flags are mutually exclusive, so in practice at most one
            // source contributes.)
            const portalUrl = baseApiPortalUrl ?? workspacePortalUrl;
            if (portalUrl) {
              vars.push({
                key: 'RAYFIN_FABRIC_PORTAL_URL',
                value: portalUrl,
              });
            }
            return vars;
          }

          // ── Resolve --workspace (display name → ID) and auto-discover item ──
          // `--workspace <name>` is the trigger that puts init into hydration
          // mode: we resolve the workspace via Fabric API, then look for an
          // AppBackend item whose name matches the resolved project name. When
          // both are found, the rest of the pipeline runs as if the user had
          // passed --workspace-id <id> --item-id <id> explicitly. When the item
          // is missing we warn and continue with workspace-only pre-seed so a
          // later `rayfin up` creates it.
          if (_options.workspace && _options.itemId) {
            modeWarn(
              mode,
              '⚠️  --item-id is ignored when --workspace is used (auto-discovered by project name).'
            );
            _options.itemId = undefined;
          }
          if (_options.workspace && !options.createProjectSemantics) {
            let resolvedWorkspaceId: string;
            let resolvedWorkspaceDisplayName: string;
            try {
              const resolvedWs = await resolveWorkspaceIdByName(
                _options.workspace,
                { interactive }
              );
              resolvedWorkspaceId = resolvedWs.id;
              resolvedWorkspaceDisplayName = resolvedWs.displayName;
              modeLog(
                mode,
                `🏢 Resolved workspace "${resolvedWs.displayName}" → ${resolvedWs.id}`
              );
              _options.workspaceId = resolvedWorkspaceId;
            } catch (err) {
              modeError(mode, `❌ ${(err as Error).message}`);
              process.exit(1);
              return;
            }

            // Compute project name in a non-interactive pre-pass so the lookup
            // works in CI/agent contexts. If we can't derive a usable name
            // here (e.g. invalid basename + no --project-name), skip the item
            // lookup with a warning instead of forcing a prompt.
            const inPlaceForLookup = isInPlaceDirectory(directory);
            let projectNameForLookup: string | undefined;
            try {
              projectNameForLookup = await resolveProjectName({
                explicitProjectName: providedProjectName,
                directory: resolve(process.cwd(), directory),
                inPlace: inPlaceForLookup,
                nonInteractive: true,
              });
            } catch {
              projectNameForLookup = undefined;
            }

            if (!projectNameForLookup) {
              modeWarn(
                mode,
                '⚠️  Could not derive a project name for AppBackend lookup. Pre-seeding workspace only; pass --project-name to enable auto-discovery.'
              );
            } else {
              try {
                // Reuse the same auth path the resolver just used so we don't
                // double-prompt. Acquire a token via the same singleton +
                // ambient/silent fallback chain; on auth failure, fall through
                // to a workspace-only warning rather than aborting the scaffold.
                const itemMgrAuth = await acquireFabricTokenForLookup({
                  interactive,
                });
                const rayfinItemManager = new RayfinItemManager(itemMgrAuth);
                const item = await rayfinItemManager.getRayfinItemByName(
                  resolvedWorkspaceId,
                  projectNameForLookup
                );
                if (item) {
                  _options.itemId = item.id;
                  modeLog(
                    mode,
                    `📡 Found AppBackend item "${projectNameForLookup}" (ID: ${item.id}) — hydration enabled`
                  );
                } else {
                  modeWarn(
                    mode,
                    `⚠️  No AppBackend item named "${projectNameForLookup}" in workspace "${resolvedWorkspaceDisplayName}" — pre-seeding workspace only; run \`rayfin up\` to create the item.`
                  );
                }
              } catch (err) {
                modeWarn(
                  mode,
                  `⚠️  Could not look up AppBackend item: ${(err as Error).message}`
                );
                modeWarn(
                  mode,
                  "   Pre-seeding workspace only; run 'rayfin up' later to create / wire up the item."
                );
              }
            }
          }

          // Discover registry entries once for all branches.
          // Walk up from cwd (not target directory, which may not exist yet).
          const registryResult = await tryDiscoverRegistryEntries(
            mode,
            process.cwd()
          );
          const firstClassRegistryEntries = registryResult.entries.filter(
            (entry) => entry.firstClass === true
          );
          const genericRegistryEntries = registryResult.entries.filter(
            (entry) => entry.firstClass !== true
          );
          const firstClassByName = new Map(
            firstClassRegistryEntries.map((entry) => [entry.name, entry])
          );
          const applyFirstClassRegistryMetadata = <
            T extends {
              name: string;
              displayName: string;
              description: string;
            },
          >(
            template: T
          ): T => {
            const override = firstClassByName.get(template.name);
            return {
              ...template,
              displayName: override?.displayName ?? template.displayName,
              description: override?.description ?? template.description,
            };
          };

          // --list-templates: output structured JSON for agent/programmatic consumption
          if (_options.listTemplates) {
            // This is the listing surface agents read, so a hidden template
            // leaking here is worse than leaking into the interactive picker:
            // an agent treats every name it sees as an offered choice. Resolution
            // stays unfiltered below, so `--template <hidden>` still works.
            const templates = visibleTemplates(discoverBundledTemplates());
            const displayedTemplates = templates.map(
              applyFirstClassRegistryMetadata
            );

            const output: Record<string, unknown> = {
              schemaVersion: 1,
              bundled: displayedTemplates.map((t) => ({
                name: t.name,
                displayName: t.displayName,
                description: t.description,
                source: 'built-in',
              })),
              registry: genericRegistryEntries.map((r) => ({
                name: r.name,
                displayName: r.displayName,
                description: r.description,
                url: r.url,
                ref: r.ref,
                path: r.path,
                default: r.default ?? false,
                source: registrySourceLabel(r.registrySource),
              })),
            };
            if (registryResult.warnings.length > 0) {
              output.warnings = registryResult.warnings;
            }

            emitJson(output);
            process.exit(0);
            return;
          }

          // Validate `--services` before any template dispatch. The bundled
          // and external template paths scaffold through a child
          // `rayfin init --from-template` whose stdio is piped, so a
          // rejection inside that child is swallowed and the flag is
          // silently dropped instead of reported. Validating here keeps the
          // error visible on every path.
          if (_options.services) {
            const parentFeatureFlags = createCliFeatureFlags(process.cwd(), {
              silent: true,
            });
            parseCommaSeparated(
              mode,
              _options.services,
              [
                'auth',
                'data',
                ...(parentFeatureFlags.get('storage') === true
                  ? ['storage']
                  : []),
                'functions',
              ],
              '--services'
            );
          }

          // ── Pure dispatch decision ────────────────────────────────────
          const bundledTemplates = discoverBundledTemplates();
          const bundledTemplateNames = bundledTemplates.map((t) => t.name);
          const decision = selectTemplateSource(
            {
              template: _options.template,
              templateName: _options.templateName,
              listTemplates: _options.listTemplates,
              fromTemplate,
            },
            bundledTemplateNames,
            registryResult.entries
          );

          /**
           * Persist Fabric environment overrides into rayfin/.env after scaffolding
           * so subsequent `rayfin dev`/`rayfin up` invocations inherit them.
           *
           * Only persists when the scaffolded output is actually a Rayfin project
           * (rayfin.yml present) — avoids polluting non-rayfin templates.
           *
           * Called by all three dispatch helpers (external/local/bundled) after
           * the handler completes.
           */
          async function persistFabricEnvOverrides(
            projectDir: string
          ): Promise<void> {
            const overrides = buildFabricEnvOverrides();
            const deferredItem =
              options.createProjectSemantics &&
              _options.workspaceId &&
              _options.itemId;
            if (overrides.length === 0 && !deferredItem) return;

            const resolvedProjectDir = projectDir;
            const rayfinYmlPath = join(
              resolvedProjectDir,
              'rayfin',
              'rayfin.yml'
            );
            if (!existsSync(rayfinYmlPath)) {
              modeWarn(
                mode,
                '⚠️  Skipping Fabric env persistence — scaffolded template does not include rayfin/rayfin.yml'
              );
              return;
            }

            try {
              if (deferredItem) {
                const config = parseRayfinYaml(
                  await readFile(rayfinYmlPath, 'utf8')
                );
                preSeedDeploymentEnvFile(
                  resolvedProjectDir,
                  {
                    fabricWorkspaceId: _options.workspaceId,
                    fabricItemId: _options.itemId,
                  },
                  config.id
                );
              }
              if (overrides.length > 0) {
                await upsertEnvVariables(
                  join(resolvedProjectDir, 'rayfin'),
                  overrides
                );
                modeLog(
                  mode,
                  '📌 Persisted Fabric environment overrides into rayfin/.env'
                );
              }
            } catch (err) {
              modeWarn(
                mode,
                `⚠️  Could not persist Fabric environment overrides: ${(err as Error).message}`
              );
            }
          }

          /** Persist create provenance only when this host supplied an ID. */
          async function persistProjectOrigin(
            projectDir: string
          ): Promise<void> {
            try {
              const projectOriginId = options.getProjectOriginId?.();
              if (
                !projectOriginId ||
                !projectOriginWriter ||
                !existsSync(join(projectDir, 'rayfin', 'rayfin.yml'))
              ) {
                return;
              }
              await projectOriginWriter.persistProjectOrigin(
                projectDir,
                projectOriginId
              );
            } catch {
              // Correlation metadata is best-effort and never blocks scaffolding.
            }
          }

          /**
           * Dispatch to `handleExternalTemplate` and persist Fabric env
           * overrides only on the success continuation. Cancellation/failure
           * throws from the handler, so persistence is naturally skipped.
           *
           * Centralized so each of the three call sites (non-interactive
           * dispatch, registry picker, raw-URL picker) can't drift.
           */
          async function dispatchExternalAndPersist(
            url: string,
            externalOptions: Parameters<typeof handleExternalTemplate>[3]
          ): Promise<void> {
            const result = await handleExternalTemplate(url, directory, mode, {
              ...externalOptions,
              itemId: options.createProjectSemantics
                ? undefined
                : externalOptions.itemId,
            });
            await persistFabricEnvOverrides(result.targetPath);
            await persistProjectOrigin(result.targetPath);
          }

          /**
           * Symmetric helper for the bundled path. Same shape as
           * dispatchExternalAndPersist: handler throws on cancel/failure,
           * dispatcher persists Fabric env on the success continuation.
           */
          async function dispatchBundledAndPersist(
            bundledOptions: Parameters<typeof handleBundledTemplate>[2]
          ): Promise<void> {
            const result = await handleBundledTemplate(directory, mode, {
              ...bundledOptions,
              itemId: options.createProjectSemantics
                ? undefined
                : bundledOptions.itemId,
            });
            await persistFabricEnvOverrides(result.targetPath);
            await persistProjectOrigin(result.targetPath);
          }

          /**
           * Symmetric helper for the local path. Same shape as
           * dispatchExternalAndPersist/dispatchBundledAndPersist.
           */
          async function dispatchLocalAndPersist(
            templatePath: string,
            localOptions: Parameters<typeof handleLocalTemplate>[3]
          ): Promise<void> {
            const result = await handleLocalTemplate(
              templatePath,
              directory,
              mode,
              {
                ...localOptions,
                itemId: options.createProjectSemantics
                  ? undefined
                  : localOptions.itemId,
              }
            );
            await persistFabricEnvOverrides(result.targetPath);
            await persistProjectOrigin(result.targetPath);
          }

          const bundledBaseOptions = {
            projectName: providedProjectName,
            services: _options.services,
            workspace: _options.workspace,
            workspaceId: _options.workspaceId,
            itemId: _options.itemId,
            dialect: _options.dialect,
            skipInstall: _options.skipInstall,
            overwrite: _options.overwrite,
            baseApiUrl: normalizedBaseApiUrl,
            useProjectNameAsDirectory,
          };

          async function dispatchTemplateDecision(
            templateDecision: typeof decision
          ): Promise<boolean> {
            switch (templateDecision.kind) {
              case 'error':
                modeError(mode, `❌ ${templateDecision.message}`);
                throw new CliHandledError(new Error(templateDecision.message));
              case 'external': {
                // Record only a generic category for telemetry. The bundled
                // fallback name (if any) is a safe built-in enum; otherwise
                // the source is a user-supplied git URL, so never record it.
                getCurrentContext()?.recordTemplateName(
                  templateDecision.fallbackBundledName ?? 'external'
                );
                const externalOptions: Parameters<
                  typeof handleExternalTemplate
                >[3] = {
                  projectName: providedProjectName,
                  services: _options.services,
                  nonInteractive: !interactive,
                  templateName: templateDecision.templateName,
                  registryPath: templateDecision.registryPath,
                  overwrite: _options.overwrite,
                  dialect: _options.dialect,
                  workspaceId: _options.workspaceId,
                  itemId: _options.itemId,
                  baseApiUrl: normalizedBaseApiUrl,
                  skipInstall: _options.skipInstall,
                  useProjectNameAsDirectory,
                };

                if (!templateDecision.fallbackBundledName) {
                  await dispatchExternalAndPersist(
                    templateDecision.url,
                    externalOptions
                  );
                  return true;
                }

                try {
                  await dispatchExternalAndPersist(
                    templateDecision.url,
                    externalOptions
                  );
                } catch (error) {
                  if (error instanceof ScaffoldCancelledError) {
                    throw error;
                  }
                  if (!(error instanceof CliHandledError)) {
                    throw error;
                  }
                  modeWarn(
                    mode,
                    `⚠️  First-class template registry failed; falling back to bundled "${templateDecision.fallbackBundledName}" template. The bundled fallback may differ from the pinned external template.`
                  );
                  await dispatchBundledAndPersist({
                    ...bundledBaseOptions,
                    template: templateDecision.fallbackBundledName,
                    nonInteractive: !interactive,
                  });
                }
                return true;
              }
              case 'local':
                // User-supplied filesystem path: record only the generic
                // category, never the path itself.
                getCurrentContext()?.recordTemplateName('local');
                await dispatchLocalAndPersist(templateDecision.path, {
                  projectName: providedProjectName,
                  services: _options.services,
                  interactive,
                  templateName: templateDecision.templateName,
                  overwrite: _options.overwrite,
                  dialect: _options.dialect,
                  workspaceId: _options.workspaceId,
                  itemId: _options.itemId,
                  baseApiUrl: normalizedBaseApiUrl,
                  skipInstall: _options.skipInstall,
                  useProjectNameAsDirectory,
                });
                return true;
              case 'bundled':
                // Guard the telemetry enum: selectTemplateSource falls through
                // to `bundled` for any unrecognized --template token, so only
                // record the name when it's a real built-in; bucket everything
                // else as 'unknown-bundled' to keep the field a fixed,
                // non-identifying enum.
                getCurrentContext()?.recordTemplateName(
                  safeTemplateNameForTelemetry(
                    templateDecision.name,
                    bundledTemplateNames
                  )
                );
                await dispatchBundledAndPersist({
                  ...bundledBaseOptions,
                  template: templateDecision.name,
                  nonInteractive: !interactive,
                });
                return true;
              case 'list-templates':
              case 'interactive':
              default:
                return false;
            }
          }

          if (await dispatchTemplateDecision(decision)) {
            return;
          }

          // Interactive mode without --from-template: offer template vs scratch choice
          if (!fromTemplate && interactive) {
            const displayedBundledTemplates = bundledTemplates.map(
              applyFirstClassRegistryMetadata
            );
            const PICKER_DEFAULT_UNIVERSAL = 'default-universal' as const;
            const PICKER_TEMPLATE = 'template' as const;
            const PICKER_EXTERNAL = 'external' as const;
            const PICKER_SCRATCH = 'scratch' as const;
            const PICKER_REGISTRY_PREFIX = '__registry__:';

            const registryEntries = genericRegistryEntries;

            const choices: { name: string; value: string }[] = [
              {
                name: '✨ Use default template',
                value: PICKER_DEFAULT_UNIVERSAL,
              },
              { name: '📦 Use a template (built-in)', value: PICKER_TEMPLATE },
              ...registryEntries.map((entry) => {
                const label = registrySourceLabel(entry.registrySource);
                return {
                  name: `📦 ${entry.displayName}${entry.description ? ` - ${entry.description}` : ''} (${label})`,
                  value: `${PICKER_REGISTRY_PREFIX}${entry.name}`,
                };
              }),
              {
                name: '🌐 Use an external git template',
                value: PICKER_EXTERNAL,
              },
              {
                name: '🔧 Start from scratch (configure manually)',
                value: PICKER_SCRATCH,
              },
            ];

            const { source } = await inquirer.prompt<{ source: string }>([
              {
                type: 'list',
                name: 'source',
                message: 'How would you like to start?',
                choices,
              },
            ]);

            if (source === PICKER_DEFAULT_UNIVERSAL) {
              await dispatchBundledAndPersist({
                ...bundledBaseOptions,
                template: 'universal-app',
                nonInteractive: false,
              });
              return;
            }

            if (source === PICKER_TEMPLATE) {
              // Count what the picker will actually show. `selectBundledTemplate`
              // filters hidden templates out of its choices, so testing the
              // unfiltered list here would hand inquirer an empty prompt.
              if (visibleTemplates(bundledTemplates).length === 0) {
                await dispatchBundledAndPersist({
                  ...bundledBaseOptions,
                  nonInteractive: false,
                });
                return;
              }
              const selectedTemplate = await selectBundledTemplate(
                displayedBundledTemplates
              );
              const selectedDecision = selectTemplateSource(
                {
                  template: selectedTemplate.name,
                  templateName: _options.templateName,
                },
                bundledTemplateNames,
                registryResult.entries
              );
              if (await dispatchTemplateDecision(selectedDecision)) {
                return;
              }
            }

            if (source.startsWith(PICKER_REGISTRY_PREFIX)) {
              const registryName = source.slice(PICKER_REGISTRY_PREFIX.length);
              const pickedEntry = registryEntries.find(
                (r) => r.name === registryName
              );
              if (!pickedEntry) {
                modeError(
                  mode,
                  `❌ Registry entry '${registryName}' not found`
                );
                process.exit(1);
                return;
              }
              // Mirror the non-interactive dispatch in selectTemplateSource:
              // thread ref via the URL fragment, path via registryPath, and
              // preserve --template-name (path scopes the clone, templateName
              // selects an entry within the scoped manifest).
              getCurrentContext()?.recordTemplateName('external');
              await dispatchExternalAndPersist(
                buildRegistryCloneUrl(pickedEntry),
                {
                  projectName: providedProjectName,
                  nonInteractive: false,
                  templateName:
                    _options.templateName ?? pickedEntry.templateName,
                  registryPath: pickedEntry.path,
                  overwrite: _options.overwrite,
                  dialect: _options.dialect,
                  workspaceId: _options.workspaceId,
                  itemId: _options.itemId,
                  baseApiUrl: normalizedBaseApiUrl,
                  skipInstall: _options.skipInstall,
                  useProjectNameAsDirectory,
                }
              );
              return;
            }

            if (source === PICKER_EXTERNAL) {
              const { gitUrl } = await inquirer.prompt<{ gitUrl: string }>({
                type: 'input',
                name: 'gitUrl',
                message: 'Git template URL:',
                validate: (val: string) =>
                  isGitUrl(val.trim()) ||
                  'Please enter a valid git URL (e.g. https://github.com/owner/repo)',
              });
              getCurrentContext()?.recordTemplateName('external');
              await dispatchExternalAndPersist(gitUrl.trim(), {
                projectName: providedProjectName,
                nonInteractive: false,
                overwrite: _options.overwrite,
                dialect: _options.dialect,
                workspaceId: _options.workspaceId,
                itemId: _options.itemId,
                baseApiUrl: normalizedBaseApiUrl,
                skipInstall: _options.skipInstall,
                useProjectNameAsDirectory,
              });
              return;
            }
            // User chose "Start from scratch" — continue with config wizard below
          }

          const header = figlet.textSync('Rayfin', {
            font: 'Standard',
            horizontalLayout: 'default',
            verticalLayout: 'default',
          });
          modeLog(mode, header);

          modeLog(mode, '🚀 Initialize a new Rayfin project\n');

          const currentDirectory = process.cwd();
          let scratchProjectName = providedProjectName;
          const scratchInputInPlace = isInPlaceDirectory(directory);
          if (useProjectNameAsDirectory && !scratchProjectName && interactive) {
            const projectNameAnswer = await inquirer.prompt<{
              projectName: string;
            }>({
              type: 'input',
              name: 'projectName',
              message: 'What is your project name?',
              validate: (input: string) => {
                if (!input.trim()) {
                  return 'Project name cannot be empty';
                }
                if (!isValidProjectName(input.trim())) {
                  return 'Use letters, numbers, spaces, hyphens, or underscores and include at least one alphanumeric character';
                }
                return true;
              },
            });
            scratchProjectName = projectNameAnswer.projectName.trim();
          }

          if (
            useProjectNameAsDirectory &&
            scratchInputInPlace &&
            !scratchProjectName &&
            !interactive
          ) {
            modeError(
              mode,
              '❌ Error: --project-name is required in non-interactive mode'
            );
            throw new CliHandledError(
              new Error('--project-name is required in non-interactive mode')
            );
          }

          const scratchTarget =
            useProjectNameAsDirectory &&
            scratchInputInPlace &&
            scratchProjectName
              ? resolveScaffoldTarget({
                  directory,
                  projectName: scratchProjectName,
                  inputInPlace: scratchInputInPlace,
                  useProjectNameAsDirectory,
                })
              : undefined;
          const scratchDirectory =
            scratchTarget?.directoryForFilesystem ??
            slugifyDirectoryArg(directory);
          const targetDirectory =
            scratchTarget?.targetPath ??
            resolve(currentDirectory, scratchDirectory);
          const rayfinDir = join(targetDirectory, 'rayfin');
          const rayfinYmlPath = join(rayfinDir, 'rayfin.yml');
          const createdFiles: string[] = [];
          const skippedFiles: string[] = [];

          // Track whether we should preserve an existing rayfin.yml when automation opts in
          let preserveExistingRayfinYml = false;

          // Check if rayfin.yml already exists
          let rayfinYmlExists = false;
          try {
            await access(rayfinYmlPath, constants.F_OK);
            rayfinYmlExists = true;
          } catch {
            // File doesn't exist, continue
          }

          // If file exists, determine whether to preserve or prompt
          if (rayfinYmlExists) {
            if (fromTemplate) {
              preserveExistingRayfinYml = true;
            } else {
              let shouldOverwrite = _options.overwrite ?? false;
              if (interactive) {
                const overwriteAnswer = await inquirer.prompt({
                  type: 'confirm',
                  name: 'overwrite',
                  message:
                    'rayfin.yml already exists. Do you want to overwrite it?',
                  default: false,
                });
                shouldOverwrite = overwriteAnswer.overwrite;
              }

              if (!shouldOverwrite) {
                modeLog(mode, '❌ Initialization cancelled');
                return;
              }
            }
          }

          // Create rayfin directory
          await mkdir(rayfinDir, { recursive: true });

          // Declare answers outside the conditional so it's available throughout
          let answers: ProjectAnswers;
          let serviceScaffoldConfig: RayfinConfig;

          // Only prompt for project details if we're creating/overwriting rayfin.yml
          if (preserveExistingRayfinYml) {
            // Read existing rayfin.yml to determine services
            const existingYmlContent = await readFile(rayfinYmlPath, 'utf8');
            serviceScaffoldConfig = parseRayfinYaml(existingYmlContent);

            // Keep the raw authored shape for identity-only rewrites. The shared
            // parser above intentionally applies runtime defaults, which must not
            // be serialized back into an external template that omitted them.
            const existingConfig = JSON.parse(
              JSON.stringify(parse(existingYmlContent))
            ) as RayfinConfig;

            // Extract enabled services from existing config
            const enabledServices: string[] = [];
            if (existingConfig.services?.auth?.enabled)
              enabledServices.push('auth');
            if (existingConfig.services?.data?.enabled)
              enabledServices.push('data');
            if (existingConfig.services?.storage?.enabled)
              enabledServices.push('storage');
            if (existingConfig.services?.functions?.enabled)
              enabledServices.push('functions');

            const featureFlags = createCliFeatureFlags(targetDirectory, {
              silent: true,
            });
            const storageEnabled = featureFlags.get('storage') === true;
            const requestedServices = _options.services
              ? parseCommaSeparated(
                  mode,
                  _options.services,
                  [
                    'auth',
                    'data',
                    ...(storageEnabled ? ['storage'] : []),
                    'functions',
                  ],
                  '--services'
                )
              : [];
            const resolvedServices = [
              ...new Set([...enabledServices, ...requestedServices]),
            ];
            validateStorageDataDependency(mode, resolvedServices);

            // Extract existing dialect
            // Priority: provided dialect flag > existing dialect > MsSql default
            const existingDialect = existingConfig.services?.data?.dialect;
            const dialectToUse = _options.dialect
              ? (_options.dialect as Dialect)
              : existingDialect
                ? existingDialect
                : DatabaseDialect.MsSql;

            // Use provided project name if available, otherwise use existing config name
            const projectName = scratchProjectName || existingConfig.name;

            answers = {
              projectName,
              services: resolvedServices,
              dialect: dialectToUse,
            };

            // Apply the minimum identity edits the sync mode is allowed
            // to make. The previous `updateRayfinYml(...)` call rebuilt
            // the `services` block from `createAuthConfig` defaults
            // whenever `--project-name` differed from the template's
            // manifest name (which `create-rayfin` and the portal-emitted
            // `npm init` flow always cause to differ), polluting external
            // templates' deliberately minimal auth/services with default
            // scaffolding (`customClaims`, `scopes`, `password`,
            // `allowedRedirectUris`, forced `staticHosting`/`functions`
            // sections). The helper writes `name`/`id` when renaming,
            // `services.data.dialect` when explicitly selected, and service
            // `enabled` fields (and application auth for newly enabled
            // Functions) when the user explicitly passed
            // `--services`. Template-enabled services remain enabled, and all
            // authored nested service settings remain intact.
            //
            // When `--dialect` is supplied against a template whose
            // `services.data` block is missing entirely, the helper has
            // nowhere to land the flag (synthesizing a new data block
            // from a flag is out of scope). Surface that explicitly so
            // the user knows the flag was dropped. We don't warn for
            // the `enabled: false` case anymore — the helper updates
            // the dialect field in place so a later flip to
            // `enabled: true` doesn't inherit a stale dialect.
            if (_options.dialect && !hasDataServiceBlock(existingConfig)) {
              modeWarn(
                mode,
                `⚠️  --dialect ${_options.dialect} was ignored: the template's rayfin.yml has no services.data block to apply it to.`
              );
            }
            const ymlContent = applyRayfinYmlIdentityEdits(
              existingConfig,
              projectName,
              _options.dialect ? dialectToUse : undefined,
              _options.services ? requestedServices : undefined
            );
            if (ymlContent !== null) {
              await writeFile(rayfinYmlPath, ymlContent, 'utf8');
              createdFiles.push('rayfin/rayfin.yml');
            } else {
              skippedFiles.push('rayfin/rayfin.yml');
            }
          } else {
            // Get project details and create rayfin.yml
            // If project name is provided via option, skip that prompt
            let promptAnswers: ProjectAnswers;

            // Resolve service availability from the CLI feature flags.
            const featureFlags = createCliFeatureFlags(targetDirectory, {
              silent: true,
            });
            const storageEnabled = featureFlags.get('storage') === true;
            const validServices = [
              'auth',
              'data',
              ...(storageEnabled ? ['storage'] : []),
              'functions',
            ];

            if (!interactive) {
              // Non-interactive mode: use flags or defaults
              if (!scratchProjectName) {
                modeError(
                  mode,
                  '❌ Error: --project-name is required in non-interactive mode'
                );
                throw new CliHandledError(
                  new Error(
                    '--project-name is required in non-interactive mode'
                  )
                );
              }

              const selectedServices = _options.services
                ? parseCommaSeparated(
                    mode,
                    _options.services,
                    validServices,
                    '--services'
                  )
                : ['auth', 'data'];

              promptAnswers = {
                projectName: scratchProjectName,
                services: selectedServices,
              };
            } else {
              // Interactive mode: prompt as before
              const prompts: any[] = [];

              if (!scratchProjectName) {
                prompts.push({
                  type: 'input',
                  name: 'projectName',
                  message: 'What is your project name?',
                  validate: (input: string) => {
                    if (!input.trim()) {
                      return 'Project name cannot be empty';
                    }
                    if (!isValidProjectName(input.trim())) {
                      return 'Use letters, numbers, spaces, hyphens, or underscores and include at least one alphanumeric character';
                    }
                    return true;
                  },
                });
              }

              prompts.push({
                type: 'checkbox',
                name: 'services',
                message: 'Which services would you like to enable?',
                choices: [
                  {
                    name: 'Auth - Authentication and authorization',
                    value: 'auth',
                  },
                  {
                    name: 'Data - Data API Builder integration',
                    value: 'data',
                  },
                  ...(storageEnabled
                    ? [
                        {
                          name: 'Storage - Blob storage management',
                          value: 'storage',
                        },
                      ]
                    : []),
                  {
                    name: 'Functions - TypeScript User Data Functions',
                    value: 'functions',
                  },
                ],
                default: ['auth', 'data'],
              });

              promptAnswers = await inquirer.prompt<ProjectAnswers>(prompts);
            }

            validateStorageDataDependency(mode, promptAnswers.services);

            // When `--dialect` is supplied against a from-scratch
            // scaffold whose resolved services list (from --services in
            // non-interactive mode or the checkbox picker in interactive
            // mode) does not include 'data', the dialect flag genuinely
            // has no effect — `createRayfinYml` will write
            // `services.data.enabled: false` and ignore the dialect.
            // Surface that explicitly so the user doesn't think the
            // dialect was applied. Mirrors the from-template path's
            // `--dialect was ignored` warning.
            if (_options.dialect && !promptAnswers.services.includes('data')) {
              modeWarn(
                mode,
                `⚠️  --dialect ${_options.dialect} was ignored: the selected services do not include 'data', so there is no data service to apply it to.`
              );
            }

            // If auth is selected, ask for auth methods
            let authMethods: AuthMethod[] = [];
            let enableEmailVerification = false;
            let enableMagicLink = false;

            if (promptAnswers.services.includes('auth')) {
              if (!interactive) {
                // Non-interactive: use flag or default
                authMethods = _options.authMethods
                  ? (parseCommaSeparated(
                      mode,
                      _options.authMethods,
                      ['fabric'],
                      '--auth-methods'
                    ) as AuthMethod[])
                  : ['fabric'];
                enableMagicLink = authMethods.includes('magic-link');
                if (enableMagicLink) {
                  enableEmailVerification = true;
                }
              } else {
                const authMethodChoices = [
                  {
                    name: 'Fabric (Entra SSO)',
                    value: 'fabric',
                    checked: true,
                  },
                ];

                const authMethodPrompt = await inquirer.prompt<{
                  authMethods: AuthMethod[];
                }>([
                  {
                    type: 'checkbox',
                    name: 'authMethods',
                    message:
                      '  └─ Which authentication methods would you like to enable?',
                    choices: authMethodChoices,
                    validate: (input: string[]) => {
                      if (input.length === 0) {
                        return 'Please select at least one authentication method';
                      }
                      return true;
                    },
                  },
                ]);
                authMethods = authMethodPrompt.authMethods;
                enableMagicLink = authMethods.includes('magic-link');

                // Magic link requires email - auto-enable and skip the prompt
                if (enableMagicLink) {
                  modeLog(
                    mode,
                    '      ℹ️  Email enabled automatically (required for magic link delivery)'
                  );
                  enableEmailVerification = true;
                } else if (authMethods.includes('email-password')) {
                  // Only ask about email verification if magic link is NOT selected
                  // (since magic link already requires email)
                  const emailPrompt = await inquirer.prompt([
                    {
                      type: 'confirm',
                      name: 'enableEmail',
                      message:
                        '      └─ Enable email verification and password reset features?',
                      default: false,
                    },
                  ]);
                  enableEmailVerification = emailPrompt.enableEmail;
                }
              }
            }

            // Prompt for dialect only if data service is enabled and dialect not provided via flag
            let dialect: Dialect | undefined;
            if (promptAnswers.services.includes('data')) {
              if (_options.dialect) {
                // Use provided dialect, normalized to lowercase
                dialect = _options.dialect.toLowerCase() as Dialect;
              } else if (!interactive) {
                // Non-interactive: default to mssql
                dialect = DatabaseDialect.MsSql;
              } else if (isFabricTargetingFlagSet(_options)) {
                // TODO: this logic can be removed now that PG is behind a feature flag, but keeping it to minimize regression risk
                // Fabric-targeted scaffolding (any of --workspace,
                // --workspace-id, --workspace-uri, --item-id, or --base-api-url
                // provided without --dialect). MSSQL is currently the only
                // dialect supported by Microsoft Fabric, so skip the prompt
                // and default to it.
                dialect = DatabaseDialect.MsSql;
                modeLog(mode, '  └─ Defaulting database dialect to MSSQL.');
              } else {
                // Build dialect choices based on feature flags
                const postgresqlEnabled =
                  featureFlags.get('postgresql') === true;
                const dialectChoices: Array<{
                  name: string;
                  value: Dialect;
                }> = [{ name: 'MSSQL', value: DatabaseDialect.MsSql }];

                if (postgresqlEnabled) {
                  dialectChoices.push({
                    name: 'PostgreSQL',
                    value: DatabaseDialect.PostgreSql,
                  });
                }

                if (dialectChoices.length === 1) {
                  // Only one dialect available — auto-select without prompting
                  dialect = dialectChoices[0].value;
                  modeLog(
                    mode,
                    `  └─ Defaulting database dialect to ${dialectChoices[0].name}.`
                  );
                } else {
                  // Prompt for dialect as sub-option after data service is selected
                  const dialectAnswer = await inquirer.prompt<{
                    dialect: Dialect;
                  }>({
                    type: 'rawlist',
                    name: 'dialect',
                    message:
                      '  └─ Which database dialect would you like to use for Data service?',
                    choices: dialectChoices,
                    default: 0,
                  });
                  dialect = dialectAnswer.dialect;
                }
              }
            } else {
              // Data service not enabled, do not include dialect
              dialect = undefined;
            }

            // Detect frontend project and prompt for static hosting
            let staticHostingConfig: StaticHostingConfig | undefined;
            let hasBuildScript = false;
            try {
              const pkgJsonPath = join(targetDirectory, 'package.json');
              const pkgContent = await readFile(pkgJsonPath, 'utf8');
              const pkgJson = JSON.parse(pkgContent);
              hasBuildScript = Boolean(pkgJson?.scripts?.build);
            } catch {
              // No package.json or unreadable — fall through; we still
              // offer static hosting in create-project semantics flows
              // because those projects routinely add a build script
              // after scaffolding.
            }

            // Offer the static-hosting prompt whenever we already see a
            // build script (any flow), or when create-project semantics
            // are in effect — `create-rayfin` and the portal-emitted
            // `npm create @microsoft/rayfin@latest` typically start from
            // an empty directory and add `package.json` after scaffold,
            // so gating purely on `hasBuildScript` silently dropped the
            // prompt for these users.
            const shouldOfferStaticHosting =
              hasBuildScript || useProjectNameAsDirectory;
            if (shouldOfferStaticHosting) {
              let enableStatic: boolean;
              if (!interactive) {
                enableStatic = _options.staticHosting ?? true;
              } else {
                modeLog(mode, '');
                if (hasBuildScript) {
                  modeLog(
                    mode,
                    '📦 Frontend build script detected in package.json'
                  );
                }
                const staticPrompt = await inquirer.prompt<{
                  enableStatic: boolean;
                }>([
                  {
                    type: 'confirm',
                    name: 'enableStatic',
                    message:
                      'Enable static hosting? (builds and deploys ./dist on rayfin up)',
                    default: true,
                  },
                ]);
                enableStatic = staticPrompt.enableStatic;
              }

              if (enableStatic) {
                staticHostingConfig = {
                  enabled: true,
                  folder: 'dist',
                  buildCommand: 'npm run build',
                  indexDocument: 'index.html',
                  assetAccess: 'protected',
                };
              }
              // If declined, staticHostingConfig stays undefined — createRayfinYml defaults to { enabled: false }
            }

            // Use provided project name if available, otherwise use prompted name
            answers = {
              projectName: scratchProjectName || promptAnswers.projectName,
              services: promptAnswers.services,
              authMethods,
              enableEmailVerification,
              dialect,
            };

            // Build auth options based on selected methods
            const authOptions: AuthOptions | undefined =
              promptAnswers.services.includes('auth')
                ? {
                    passwordEnabled: authMethods.includes('email-password'),
                    passwordless: enableMagicLink
                      ? { magicLinkEnabled: true }
                      : undefined,
                    fabricEnabled: authMethods.includes('fabric'),
                  }
                : undefined;

            // Generate and write rayfin.yml
            const ymlContent = createRayfinYml(
              answers.projectName,
              answers.services,
              enableEmailVerification,
              dialect,
              authOptions,
              staticHostingConfig
            );
            serviceScaffoldConfig = parseRayfinYaml(ymlContent);
            await writeFile(rayfinYmlPath, ymlContent, 'utf8');
          }

          // Service source directories can be relocated out of the default
          // `rayfin/<service>/` location via a `services.<name>.path` override
          // in rayfin.yml (e.g. a multi-package template that keeps its data /
          // functions / storage projects under `packages/`). When a service
          // declares an explicit path the project already lives there — the
          // init flow must NOT create an empty `rayfin/<service>` directory or
          // scaffold a stray default functions app on top of it. The decision
          // is factored into planServiceDirectoryScaffolding for unit testing.
          // Resolve assets directory (used by both functions scaffold and .gitignore copy)
          const assetsDir = resolve(__dirname, '..', '..', 'assets');
          const functionsDir = join(rayfinDir, 'functions');

          const scaffoldPlan = planServiceDirectoryScaffolding({
            enabledServices: answers.services,
            config: serviceScaffoldConfig,
            fromTemplate,
            functionsDefaultDirExists: existsSync(functionsDir),
          });

          if (scaffoldPlan.createDataDir) {
            await mkdir(join(rayfinDir, 'data'), { recursive: true });
          }
          if (scaffoldPlan.createStorageDir) {
            await mkdir(join(rayfinDir, 'storage'), { recursive: true });
          }
          if (scaffoldPlan.scaffoldFunctions) {
            await scaffoldFunctionsDirectory(
              targetDirectory,
              functionsDir,
              createdFiles,
              assetsDir
            );
          }

          // Copy .gitignore file with overwrite confirmation
          const gitignorePath = join(targetDirectory, '.gitignore');
          const gitignoreSourcePath = join(assetsDir, '.gitignore.template');

          let gitignoreExists = false;
          try {
            await access(gitignorePath, constants.F_OK);
            gitignoreExists = true;
          } catch {
            // File doesn't exist, continue
          }

          if (gitignoreExists) {
            if (fromTemplate) {
              // External templates frequently ship their own .gitignore
              // (template-author hygiene + project-specific ignores). The
              // sync mode merges the canonical Rayfin asset's required
              // patterns INTO the existing file rather than clobbering
              // it — preserves the template author's choices while still
              // guaranteeing the rayfin-managed patterns
              // (rayfin/.env*, rayfin/.deployments.json, rayfin/.*.tmp,
              // rayfin/.temp/)
              // are present. Idempotent: re-running on a fully covered
              // file leaves the bytes unchanged.
              const [existingGitignore, sourceGitignore] = await Promise.all([
                readFile(gitignorePath, 'utf8'),
                readFile(gitignoreSourcePath, 'utf8'),
              ]);
              const merged = mergeGitignore(existingGitignore, sourceGitignore);
              if (merged === existingGitignore) {
                skippedFiles.push('.gitignore');
              } else {
                await writeFile(gitignorePath, merged, 'utf8');
                createdFiles.push('.gitignore');
              }
            } else {
              let shouldOverwriteGitignore = _options.overwrite ?? false;
              if (interactive) {
                const gitignoreOverwriteAnswer = await inquirer.prompt({
                  type: 'confirm',
                  name: 'overwrite',
                  message:
                    '.gitignore already exists. Do you want to overwrite it?',
                  default: false,
                });
                shouldOverwriteGitignore = gitignoreOverwriteAnswer.overwrite;
              }

              if (shouldOverwriteGitignore) {
                await copyFile(gitignoreSourcePath, gitignorePath);
                createdFiles.push('.gitignore');
              } else {
                skippedFiles.push('.gitignore');
              }
            }
          } else {
            await copyFile(gitignoreSourcePath, gitignorePath);
            createdFiles.push('.gitignore');
          }

          // Create or update rayfin/tsconfig.json
          if (!fromTemplate) {
            const rayfinTsconfigPath = join(rayfinDir, 'tsconfig.json');
            const baseTsconfigPath = join(targetDirectory, 'tsconfig.json');

            // Check if base tsconfig.json exists
            let baseTsconfigExists = false;
            try {
              await access(baseTsconfigPath, constants.F_OK);
              baseTsconfigExists = true;
            } catch {
              // File doesn't exist
            }

            // Check if rayfin/tsconfig.json already exists
            let rayfinTsconfigExists = false;
            try {
              await access(rayfinTsconfigPath, constants.F_OK);
              rayfinTsconfigExists = true;
            } catch {
              // File doesn't exist
            }

            let shouldCreateTsconfig = true;

            // Prompt for overwrite if file exists
            if (rayfinTsconfigExists) {
              if (interactive) {
                const tsconfigOverwriteAnswer = await inquirer.prompt({
                  type: 'confirm',
                  name: 'overwrite',
                  message:
                    'rayfin/tsconfig.json already exists. Do you want to overwrite it?',
                  default: false,
                });
                shouldCreateTsconfig = tsconfigOverwriteAnswer.overwrite;
              } else {
                shouldCreateTsconfig = _options.overwrite ?? false;
              }
            }

            if (shouldCreateTsconfig) {
              // Create tsconfig content based on whether base tsconfig exists
              const tsconfigContent = baseTsconfigExists
                ? JSON.stringify(
                    {
                      extends: '../tsconfig.json',
                      compilerOptions: {
                        outDir: RAYFIN_COMPILED_DIR,
                        rootDir: '.',
                        declaration: true,
                        composite: true,
                        noEmit: false,
                        module: 'nodenext',
                        moduleResolution: 'nodenext',
                      },
                      include: ['**/*'],
                      exclude: ['.temp/**/*', 'functions/**/*'],
                    },
                    null,
                    2
                  )
                : JSON.stringify(
                    {
                      compilerOptions: {
                        outDir: RAYFIN_COMPILED_DIR,
                        rootDir: '.',
                        declaration: true,
                        composite: true,
                        noEmit: false,
                        module: 'nodenext',
                        moduleResolution: 'nodenext',
                      },
                      include: ['**/*'],
                      exclude: ['.temp/**/*'],
                    },
                    null,
                    2
                  );

              await writeFile(
                rayfinTsconfigPath,
                tsconfigContent + '\n',
                'utf8'
              );
              createdFiles.push('rayfin/tsconfig.json');
            } else {
              skippedFiles.push('rayfin/tsconfig.json');
            }
          }

          // Install @microsoft/rayfin-* packages if package.json exists.
          // External/local templates use the narrower skip flag so authored package versions are preserved
          // without suppressing the parent pipeline's normal template dependency install.
          const hasPackageJson = await checkPackageJsonExists(targetDirectory);
          if (
            hasPackageJson &&
            !_options.skipInstall &&
            !_options.skipRayfinPackageInstall
          ) {
            try {
              const isDevelopmentMode = await isInDevelopmentMode();

              if (isDevelopmentMode) {
                modeLog(
                  mode,
                  '🔧 Development mode detected - using local workspace packages'
                );
                const localPackagePaths = await getLocalPackagePaths();
                await installLocalPackages(
                  mode,
                  targetDirectory,
                  localPackagePaths
                );
                modeLog(
                  mode,
                  '✅ @microsoft/rayfin-* packages installed successfully from local workspace!'
                );
              } else {
                modeLog(
                  mode,
                  '🌐 Production mode - installing from npm registry'
                );
                await installRayfinPackages(mode, targetDirectory);
                modeLog(
                  mode,
                  '✅ @microsoft/rayfin-* packages installed successfully from npm registry!'
                );
              }
            } catch (error) {
              const isDevelopmentMode = await isInDevelopmentMode();
              modeWarn(
                mode,
                '⚠️  Warning: Failed to install @microsoft/rayfin-* packages:',
                error instanceof Error ? error.message : 'Unknown error'
              );

              if (isDevelopmentMode) {
                modeWarn(
                  mode,
                  '   Development mode detected. You can install them manually using:'
                );
                modeWarn(
                  mode,
                  '   npm install --save file:../path/to/packages/typescript-sdk/core file:../path/to/packages/typescript-sdk/data file:../path/to/packages/typescript-sdk/client'
                );
                modeWarn(
                  mode,
                  '   npm install --save-dev file:../path/to/packages/tools/cli'
                );
              } else {
                modeWarn(
                  mode,
                  '   Production mode detected. You can install them manually using:'
                );
                modeWarn(
                  mode,
                  '   npm install --save @microsoft/rayfin-core @microsoft/rayfin-data @microsoft/rayfin-client'
                );
                modeWarn(
                  mode,
                  '   npm install --save-dev @microsoft/rayfin-cli'
                );
              }
            }
          } else if (!hasPackageJson && !_options.skipInstall) {
            modeWarn(
              mode,
              '⚠️  Warning: package.json not found in target directory'
            );
            modeWarn(
              mode,
              '   Skipping @microsoft/rayfin-* packages installation'
            );

            const isDevelopmentMode = await isInDevelopmentMode();
            if (isDevelopmentMode) {
              modeWarn(
                mode,
                '   Development mode: Create a package.json first, then install with file: paths'
              );
            } else {
              modeWarn(
                mode,
                '   Production mode: Create a package.json first, then run:'
              );
              modeWarn(
                mode,
                '   npm install --save @microsoft/rayfin-core @microsoft/rayfin-data @microsoft/rayfin-client'
              );
              modeWarn(mode, '   npm install --save-dev @microsoft/rayfin-cli');
            }
          }

          // Pre-seed deployment metadata if artifact context was provided
          if (_options.itemId && !_options.workspaceId) {
            modeError(
              mode,
              '❌ --item-id requires --workspace-id to pre-seed deployment metadata.'
            );
            throw new CliHandledError(
              new Error(
                '--item-id requires --workspace-id to pre-seed deployment metadata'
              )
            );
          } else if (_options.itemId || _options.workspaceId) {
            // When both --workspace-id and --item-id are present, attempt to
            // fully hydrate the deployment record by calling Fabric (same
            // path as `rayfin up`). On any failure fall back to the minimal
            // pre-seed and warn the user to run `rayfin up` later.
            let hydrated = false;
            if (
              _options.workspaceId &&
              _options.itemId &&
              !options.createProjectSemantics
            ) {
              try {
                const result = await hydrateDeploymentFromFabric({
                  projectRoot: targetDirectory,
                  workspaceId: _options.workspaceId,
                  itemId: _options.itemId,
                });
                hydrated = true;
                modeLog(
                  mode,
                  `📡 Hydrated deployment from workspace "${result.workspaceDisplayName}"`
                );
                modeLog(mode, `   └─ BaaS endpoint: ${result.baasEndpoint}`);
                createdFiles.push('rayfin/.deployments.json');
              } catch (error) {
                modeWarn(
                  mode,
                  `⚠️  Could not hydrate deployment from Fabric: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
                modeWarn(
                  mode,
                  "   Recording workspace + item ID locally; run 'rayfin up' later to fetch the BaaS endpoint and publishable key."
                );
              }
            }

            if (!hydrated) {
              const wrote = preSeedDeploymentEnvFile(
                targetDirectory,
                {
                  fabricItemId: _options.itemId,
                  fabricWorkspaceId: _options.workspaceId,
                },
                answers.projectName
              );
              if (wrote) {
                modeLog(
                  mode,
                  '📌 Pre-seeded deployment registry with artifact context'
                );
                createdFiles.push('rayfin/.deployments.json');
              }
            }
          }

          // Persist Fabric environment overrides (--base-api-url, --workspace-uri)
          // into rayfin/.env so subsequent rayfin commands inherit them.
          const fabricEnvOverrides = buildFabricEnvOverrides();
          if (fabricEnvOverrides.length > 0) {
            try {
              await upsertEnvVariables(rayfinDir, fabricEnvOverrides);
              createdFiles.push('rayfin/.env');
            } catch (err) {
              modeWarn(
                mode,
                `⚠️  Could not persist Fabric environment overrides: ${(err as Error).message}`
              );
            }
          }

          // Success message
          modeLog(mode, '✅ Rayfin project initialized successfully!');
          modeLog(mode, `📁 Project directory: ${normalizePath(rayfinDir)}`);
          modeLog(
            mode,
            `📄 Configuration file: ${normalizePath(rayfinYmlPath)}`
          );
          modeLog(mode, `🔖 Project Name: ${answers.projectName}`);
          modeLog(mode, `🔖 Project ID: ${createSlug(answers.projectName)}`);
          modeLog(mode, `🔧 Enabled services: ${answers.services.join(', ')}`);

          if (createdFiles.length > 0) {
            modeLog(mode, '📝 Created starter files:');
            createdFiles.forEach((file) => {
              modeLog(mode, `   └── ${file}`);
            });
          }

          if (skippedFiles.length > 0) {
            modeLog(mode, '⏭️  Skipped existing files:');
            skippedFiles.forEach((file) => {
              modeLog(mode, `   └── ${file}`);
            });
          }

          // The legacy blank-config path doesn't run runScaffoldPipeline (which
          // is the standard ai-files entry point). Invoke it directly here so a
          // user who picks "Start from scratch" still gets the same agent-file
          // wiring as someone who picked a template — per spec the ai-files
          // install runs for every successful init.
          installAgentFilesAfterScaffold(targetDirectory, mode);
          await persistProjectOrigin(targetDirectory);
        } catch (error) {
          // Pass cancellation through unwrapped — wrappers (rayfin
          // scripts/main, create-rayfin) attribute it to Canceled
          // telemetry rather than Failure/UserFault.
          if (error instanceof ScaffoldCancelledError) {
            throw error;
          }
          // Pass CliHandledError through unwrapped too — the handler that
          // threw it has already displayed a user-friendly message
          // (e.g. handleBundledTemplate's inner catch logs
          // "❌ Failed to create project: ..." before throwing). Re-printing
          // here would double-emit and dump the CliHandledError stack via
          // console.error's Error formatting. The wrappers honor this same
          // contract — see scripts/main and create-rayfin/src/index.ts.
          if (error instanceof CliHandledError) {
            throw error;
          }
          if (mode === 'json') {
            emitJsonError(
              mode,
              error instanceof Error ? error.message : String(error),
              undefined,
              error
            );
          }
          modeError(mode, '❌ Error initializing project:', error);
          throw new CliHandledError(error);
        }
      })
  );
};

export function createInitCommand(): Command {
  return init().addCommand(aiFilesCommand);
}
