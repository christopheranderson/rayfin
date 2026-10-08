import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { resolve } from 'path';

import {
  parseManifest,
  flattenManifestEntries,
  resolveEntryPath,
} from '@microsoft/rayfin-tools-common/_internal/templates';
import type { ResolvedTemplate } from '@microsoft/rayfin-tools-common/_internal/templates';
import {
  parseGitUrl,
  fetchTemplate,
} from '@microsoft/rayfin-tools-common/_internal/templates/git';

import { CliHandledError } from '../errors.js';
import {
  modeLog,
  modeError,
  modeWarn,
  type OutputMode,
} from '../utils/output-mode.js';
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
  wipeTargetDirectory,
} from '../utils/scaffold-pipeline.js';
import { selectTemplateEntry } from '../utils/template-entry-selector.js';

/**
 * Handle scaffolding from an external git template URL.
 * Supports single-entry manifests (auto-select) and multi-entry manifests
 * with groups (interactive navigation or --template-name selection).
 *
 * @returns the completed scaffold target path.
 * @throws {@link ScaffoldCancelledError} on user cancellation. Triggers
 *   per `openspec/specs/rayfin-cli-init/spec.md`:
 *   - declined overwrite prompt against a non-empty target (named or in-place)
 *   - non-interactive run without `--overwrite` against a non-empty target
 *   Wrappers map this to exit code 2 + Canceled telemetry.
 * @throws {@link CliHandledError} on hard failure (clone failure, manifest
 *   parse error, scaffold failure). Handler emitted a friendly message;
 *   wrappers must not re-print.
 */
export async function handleExternalTemplate(
  templateUrl: string,
  directory: string,
  mode: OutputMode,
  options: {
    projectName?: string;
    services?: string;
    nonInteractive?: boolean;
    templateName?: string;
    registryPath?: string;
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

  // Resolve project name BEFORE network/disk work so validation errors
  // surface cleanly (no scaffold-failure wrapping, no wasted clone).
  let resolvedProjectName: string;
  try {
    resolvedProjectName = await resolveProjectName({
      explicitProjectName: options.projectName,
      directory: targetDirectoryForName,
      inPlace: inputInPlace,
      nonInteractive: options.nonInteractive,
    });
  } catch (err) {
    modeError(mode, err instanceof Error ? err.message : String(err));
    throw new CliHandledError(err);
  }

  modeLog(mode, `🔖 Project name: ${resolvedProjectName}`);

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

  // Conflict prompt for existing non-empty target (matches bundled flow behavior).
  // Empty pre-existing dirs are fine — proceed without prompt.
  // We deliberately do NOT wipe yet: if clone / manifest parse subsequently
  // fails, the user's pre-existing data is preserved. The wipe runs just
  // before instantiateTemplate, after the source is validated.
  // For in-place scaffolds (`isInPlaceDirectory(directory)`) we still prompt —
  // the spec requires exit code 2 on declined-overwrite for ANY non-empty
  // target, including the cwd. Wipe is suppressed for in-place below;
  // per-file collision resolution handles overlap with existing files.
  let userConsentedOverwrite = false;
  let targetWasEmpty = false;
  if (targetExisted) {
    const result = await assertTargetConflictOrThrow(
      targetDirectory,
      { nonInteractive: options.nonInteractive, overwrite: options.overwrite },
      mode
    );
    userConsentedOverwrite = result.consentedOverwrite;
    targetWasEmpty = result.targetWasEmpty;
  }

  modeLog(mode, '📦 Scaffolding from external template...\n');

  const source = parseGitUrl(templateUrl);

  modeLog(mode, `📥 Cloning template from ${source.url}...`);
  let clonedPath: string;
  try {
    clonedPath = await fetchTemplate(source, {
      onArchiveFallback: (message) => modeLog(mode, `ℹ️  ${message}`),
    });
  } catch (err) {
    modeError(
      mode,
      `❌ Failed to fetch template: ${err instanceof Error ? err.message : String(err)}`
    );
    throw new CliHandledError(err);
  }

  let scaffoldError: Error | undefined;

  try {
    // If a registry path is specified, scope to that subdirectory.
    // Use resolveEntryPath for hardened path validation (rejects ../, absolute, symlink escapes).
    let manifestRoot = clonedPath;
    let manifest;
    if (options.registryPath) {
      const resolved = await resolveEntryPath(clonedPath, options.registryPath);
      manifestRoot = resolved.sourcePath;
      manifest = resolved.manifest;
    } else {
      manifest = await parseManifest(manifestRoot);
    }
    const allEntries = flattenManifestEntries(manifest.entries);

    if (allEntries.length === 1) {
      modeLog(
        mode,
        `✅ Found template: ${manifest.metadata.displayName}${manifest.metadata.description ? ` — ${manifest.metadata.description}` : ''}`
      );
    } else {
      modeLog(
        mode,
        `📚 Found ${allEntries.length} templates: ${manifest.metadata.displayName}${manifest.metadata.description ? ` — ${manifest.metadata.description}` : ''}`
      );
    }

    let template: ResolvedTemplate = await selectTemplateEntry(
      manifest,
      manifestRoot,
      {
        interactive: options.nonInteractive !== true,
        templateName: options.templateName,
        onPathFallback: (message) => modeWarn(mode, message),
      }
    );

    if (allEntries.length > 1) {
      modeLog(
        mode,
        `📦 Selected template: ${template.manifest.metadata.displayName}`
      );
    }

    template = { ...template, source };

    const presets: Record<string, unknown> = {
      projectName: resolvedProjectName,
    };

    // The conflict check happened earlier (before clone). Now that the
    // template source is validated and the manifest parses, it's safe to
    // wipe pre-existing contents: a failure here is on the new template,
    // not a clone/parse blow-up that should preserve user data. Skip wipe
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
        allowInteractiveFabricAuth: options.nonInteractive !== true,
      },
      async () => {
        await instantiateAndReport(
          template,
          {
            targetDir: targetDirectory,
            presets,
            // User confirmed overwrite of a non-empty pre-existing target —
            // forward the consent to the template engine so file conflicts
            // are resolved by overwriting (not silently skipping).
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

    // Clean up partial output. Three cases need cleanup: (1) we created
    // the target directory ourselves; (2) user consented to overwrite an
    // existing target — we wiped it first, so partial scaffold under a
    // wiped dir is also our mess to clean up; (3) the target existed but
    // was empty, so there was nothing of the user's to preserve.
    await cleanupPartialScaffold(
      targetDirectory,
      !inPlace && (!targetExisted || targetWasEmpty || userConsentedOverwrite),
      mode
    );

    scaffoldError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Always clean up the cloned temp directory
    try {
      await rm(clonedPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  if (scaffoldError) {
    // Preserve the original error so telemetry's errorType/errorName
    // captures the actual scaffold failure (e.g. EACCES, ENOSPC,
    // template-engine validation error) instead of a synthetic 'Error'
    // bucket. Mirrors handleBundledTemplate's catch-block re-throw.
    throw new CliHandledError(scaffoldError);
  }

  return { targetPath: targetDirectory };
}
