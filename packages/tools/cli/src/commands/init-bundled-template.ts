import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import { DatabaseDialect } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  findTemplateByName,
  transformProjectName,
  type TemplateInfo,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import figlet from 'figlet';
import inquirer from 'inquirer';
import { parse } from 'yaml';

import { CliHandledError } from '../errors.js';
import { createCliFeatureFlags } from '../utils/feature-flags.js';
import { modeLog, modeError, type OutputMode } from '../utils/output-mode.js';
import {
  type ScaffoldResult,
  assertTargetConflictOrThrow,
  cleanupPartialScaffold,
  isInPlaceDirectory,
  printNextStepsBanner,
  resolveProjectName,
  resolveScaffoldTarget,
  runScaffoldPipeline,
  wipeTargetDirectory,
} from '../utils/scaffold-pipeline.js';
import {
  copyTemplateFiles,
  discoverBundledTemplates,
  listBundledTemplates,
  selectBundledTemplate,
} from '../utils/template-scaffold.js';

import { isFabricTargetingFlagSet } from './init-helpers.js';

/**
 * Whether a bundled template enables the data service in its authored
 * rayfin/rayfin.yml. Returns true only when data is explicitly enabled; on
 * any read/parse failure we assume enabled to preserve the historical
 * dialect-prompt behavior.
 */
function templateEnablesDataService(templatePath: string): boolean {
  try {
    const ymlPath = join(templatePath, 'rayfin', 'rayfin.yml');
    const parsed = parse(readFileSync(ymlPath, 'utf8')) as
      | { services?: { data?: { enabled?: boolean } } }
      | null
      | undefined;
    return parsed?.services?.data?.enabled === true;
  } catch {
    return true;
  }
}

/**
 * Handle scaffolding from a bundled template.
 *
 * @returns the completed scaffold target path.
 * @throws {@link ScaffoldCancelledError} on user cancellation. Triggers
 *   per `openspec/specs/rayfin-cli-init/spec.md`:
 *   - declined overwrite prompt against a non-empty target
 *   - non-interactive run without `--overwrite` against a non-empty target
 *   Wrappers map this to exit code 2 + Canceled telemetry.
 * @throws {@link CliHandledError} on configuration / template-resolution
 *   failures (handler emitted a friendly message; wrappers must not re-print).
 */
export async function handleBundledTemplate(
  directory: string,
  mode: OutputMode,
  options: {
    template?: string;
    projectName?: string;
    services?: string;
    nonInteractive?: boolean;
    workspace?: string;
    workspaceId?: string;
    itemId?: string;
    dialect?: string;
    skipInstall?: boolean;
    overwrite?: boolean;
    baseApiUrl?: string;
    useProjectNameAsDirectory?: boolean;
  }
): Promise<ScaffoldResult> {
  const templates = discoverBundledTemplates();

  if (templates.length === 0) {
    modeError(
      mode,
      '❌ No templates found. Cannot create project without templates.'
    );
    throw new CliHandledError(
      new Error('No templates found. Cannot create project without templates.')
    );
  }

  // Display welcome header
  const header = figlet.textSync('Rayfin', {
    font: 'Standard',
    horizontalLayout: 'default',
    verticalLayout: 'default',
  });
  modeLog(mode, header);
  modeLog(mode, "Let's create your project.\n");

  // Select template
  let selectedTemplate: TemplateInfo;
  if (options.template) {
    const found = findTemplateByName(templates, options.template);
    if (!found) {
      modeError(mode, `❌ Template "${options.template}" not found`);
      listBundledTemplates(templates);
      throw new CliHandledError(
        new Error(`Template "${options.template}" not found`)
      );
    }
    selectedTemplate = found;
  } else if (options.nonInteractive) {
    modeError(mode, '❌ --template is required in non-interactive mode');
    throw new CliHandledError(
      new Error('--template is required in non-interactive mode')
    );
  } else {
    selectedTemplate = await selectBundledTemplate(templates);
  }

  // Get or prompt for project name. Pass the ORIGINAL positional to
  // resolveProjectName so the basename-fallback yields the user's display
  // form ("My App"), not the slug. Wrap in try/catch -> CliHandledError so
  // validation failures (invalid project name, in-place at filesystem root,
  // --project-name required in non-interactive) surface a clean
  // `❌ <message>` to the user instead of falling through to the top-level
  // catch's `❌ Error initializing project: ...` envelope. Matches the
  // pattern used by handleExternalTemplate and handleLocalTemplate.
  const inputInPlace = isInPlaceDirectory(directory);
  let projectNameInput: string;
  try {
    projectNameInput = await resolveProjectName({
      explicitProjectName: options.projectName,
      directory: resolve(process.cwd(), directory),
      inPlace: inputInPlace,
      nonInteractive: options.nonInteractive,
    });
  } catch (err) {
    modeError(mode, err instanceof Error ? err.message : String(err));
    throw new CliHandledError(err);
  }

  const names = transformProjectName(projectNameInput);
  const projectDisplayName = names.display;
  const projectSlug = names.kebab;

  if (!projectSlug) {
    modeError(
      mode,
      '❌ Project name could not be converted into a valid project ID'
    );
    throw new CliHandledError(
      new Error('Project name could not be converted into a valid project ID')
    );
  }

  modeLog(mode, `🔖 Project name: ${projectDisplayName}`);

  // Whether the scaffolded project will end up with the data service enabled:
  // the template ships it enabled, or the user opted in via `--services data`
  // (which the scaffold pipeline forwards to enable the block). Either way a
  // dialect is meaningful and must be chosen/forwarded.
  const dataWillBeEnabled =
    templateEnablesDataService(selectedTemplate.path) ||
    (options.services ?? '')
      .split(',')
      .map((service) => service.trim().toLowerCase())
      .includes('data');

  // Prompt for database dialect. When any Fabric-targeting flag is provided,
  // the scaffold targets Microsoft Fabric, which currently only supports MSSQL,
  // so skip the prompt and default to it.
  let selectedDialect: string | undefined;
  if (options.dialect) {
    // Explicit --dialect is always honored, even for data-disabled templates:
    // it lets a user pre-set the dialect used when they enable data later.
    selectedDialect = options.dialect;
  } else if (!dataWillBeEnabled) {
    // No data service will be enabled (template disables it and the user did
    // not select it) — no database is provisioned, so asking for or defaulting
    // a dialect is meaningless. Leave it unset and keep the template's authored
    // value.
    selectedDialect = undefined;
  } else if (isFabricTargetingFlagSet(options)) {
    selectedDialect = DatabaseDialect.MsSql;
    modeLog(mode, '  └─ Defaulting database dialect to MSSQL.');
  } else if (options.nonInteractive) {
    selectedDialect = DatabaseDialect.MsSql;
  } else {
    // Build dialect choices based on feature flags
    const featureFlags = createCliFeatureFlags(
      resolve(process.cwd(), directory),
      { silent: true }
    );
    const postgresqlEnabled = featureFlags.get('postgresql') === true;
    const dialectChoices: Array<{ name: string; value: string }> = [
      { name: 'MSSQL', value: DatabaseDialect.MsSql },
    ];

    if (postgresqlEnabled) {
      dialectChoices.push({
        name: 'PostgreSQL',
        value: DatabaseDialect.PostgreSql,
      });
    }

    if (dialectChoices.length === 1) {
      // Only one dialect available — auto-select without prompting
      selectedDialect = dialectChoices[0].value;
      modeLog(
        mode,
        `  └─ Defaulting database dialect to ${dialectChoices[0].name}.`
      );
    } else {
      const dialectAnswer = await inquirer.prompt<{ dialect: string }>({
        type: 'rawlist',
        name: 'dialect',
        message:
          '  └─ Which database dialect would you like to use for Data service?',
        choices: dialectChoices,
        default: 0,
      });
      selectedDialect = dialectAnswer.dialect;
    }
  }

  modeLog(
    mode,
    `\n🚀 Creating project "${projectDisplayName}" (${projectSlug}) from "${selectedTemplate.displayName}" template\n`
  );

  const {
    inPlace: scaffoldInPlace,
    directoryForFilesystem,
    targetPath,
  } = resolveScaffoldTarget({
    directory,
    projectName: projectDisplayName,
    inputInPlace,
    useProjectNameAsDirectory: options.useProjectNameAsDirectory,
  });

  // Check for conflicts. Empty pre-existing dirs are fine — match
  // external/local UX (don't prompt the user for an overwrite that has
  // nothing to overwrite).
  const targetExisted = existsSync(targetPath);
  let userConsentedOverwrite = false;
  let targetWasEmpty = false;
  if (targetExisted) {
    const conflict = await assertTargetConflictOrThrow(
      targetPath,
      {
        nonInteractive: options.nonInteractive,
        overwrite: options.overwrite,
      },
      mode
    );
    userConsentedOverwrite = conflict.consentedOverwrite;
    targetWasEmpty = conflict.targetWasEmpty;
  }

  try {
    // Defer wipe until after we're committed to scaffolding; symmetric
    // to external/local. (Bundled has nothing async between consent and
    // wipe, but keeping the structure aligned makes drift less likely.)
    if (userConsentedOverwrite && !scaffoldInPlace) {
      wipeTargetDirectory(targetPath, mode);
    }
    mkdirSync(targetPath, { recursive: true });

    await runScaffoldPipeline(
      {
        targetPath,
        projectName: projectDisplayName,
        services: options.services,
        dialect: selectedDialect,
        workspaceId: options.workspaceId,
        itemId: options.itemId,
        baseApiUrl: options.baseApiUrl,
        skipInstall: options.skipInstall,
        // Bundled templates author their own `@microsoft/rayfin-*` ranges, so
        // re-installing them here would repin the root to the CLI's exact
        // version while nested workspace manifests keep the authored range —
        // the version skew that makes `match:` pack pins unresolvable.
        preserveTemplatePackageVersions: true,
        allowInteractiveFabricAuth: options.nonInteractive !== true,
      },
      async () => {
        copyTemplateFiles(selectedTemplate.path, targetPath);
      },
      mode
    );

    // Success message
    printNextStepsBanner(mode, directoryForFilesystem, scaffoldInPlace);

    return { targetPath };
  } catch (error) {
    modeError(
      mode,
      `❌ Failed to create project: ${error instanceof Error ? error.message : String(error)}`
    );

    // Bundled cleanup parity with external/local: only clean up when we
    // own the target (we created it, the user consented to overwrite — we
    // wiped it ourselves so a partial scaffold is our mess — or it was
    // empty when we started, so there was nothing of the user's to lose).
    await cleanupPartialScaffold(
      targetPath,
      !scaffoldInPlace &&
        (!targetExisted || targetWasEmpty || userConsentedOverwrite),
      mode
    );

    // Re-throw so the dispatcher (or its wrapper) can attribute the
    // failure to telemetry. CliHandledError signals "message already
    // shown to the user" — see init.ts top-level catch.
    throw error instanceof CliHandledError ? error : new CliHandledError(error);
  }
}
