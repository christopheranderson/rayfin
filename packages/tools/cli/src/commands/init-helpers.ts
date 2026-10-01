/**
 * Pure helpers extracted from init.ts for unit testing.
 *
 * These functions encode the decision logic of `rayfin init`'s flag handling
 * and template-source dispatch, with no I/O or process.exit side effects.
 * The init command composes them with side-effecting code (filesystem, env
 * mutation, prompts) elsewhere.
 */
import path from 'path';

import { DatabaseDialect } from '@microsoft/rayfin-tools-common/_internal/config';
import { isGitUrl } from '@microsoft/rayfin-tools-common/_internal/templates';

/** Check if a string looks like a local filesystem path. */
export function isLocalPath(input: string): boolean {
  return (
    input === '.' ||
    input === '..' ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('.\\') ||
    input.startsWith('..\\') ||
    path.isAbsolute(input)
  );
}

// ── validateInitFlags ─────────────────────────────────────────────────────

export interface InitFlagInputs {
  template?: string;
  templateName?: string;
  workspace?: string;
  workspaceUri?: string;
  workspaceId?: string;
  baseApiUrl?: string;
  dialect?: string;
}

/**
 * True when any flag indicates the scaffold is targeting Microsoft Fabric.
 * Fabric currently supports only MSSQL, so callers use this to skip the
 * dialect prompt and default to MSSQL.
 *
 * Shared by the bundled-template path ({@link handleBundledTemplate}) and
 * the interactive `rayfin init` flow so both treat the flag set identically.
 */
export function isFabricTargetingFlagSet(opts: {
  workspace?: string;
  workspaceId?: string;
  workspaceUri?: string;
  itemId?: string;
  baseApiUrl?: string;
}): boolean {
  return Boolean(
    opts.workspace ||
    opts.workspaceId ||
    opts.workspaceUri ||
    opts.itemId ||
    opts.baseApiUrl
  );
}

/**
 * Validate workspace targeting: accept at most one selector and require a
 * GUID for `--workspace-id`. Returns each conflicting flag combination before
 * checking the identifier so callers can resolve conflicts first.
 *
 * Reused by both `rayfin init` (via {@link validateInitFlags}) and
 * `rayfin up` so the flag-conflict matrix lives in one place.
 */
export function validateWorkspaceFlagSet(opts: {
  workspace?: string;
  workspaceId?: string;
  workspaceUri?: string;
}): string[] {
  const errors: string[] = [];
  if (opts.workspace && opts.workspaceId) {
    errors.push('--workspace and --workspace-id are mutually exclusive.');
  }
  if (opts.workspace && opts.workspaceUri) {
    errors.push('--workspace and --workspace-uri are mutually exclusive.');
  }
  if (opts.workspaceUri && opts.workspaceId) {
    errors.push('--workspace-uri and --workspace-id are mutually exclusive.');
  }
  if (
    errors.length === 0 &&
    opts.workspaceId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      opts.workspaceId
    )
  ) {
    errors.push(
      '--workspace-id must be a GUID.\n' +
        '   Use --workspace-uri <url> for a Fabric or Power BI portal URL, or pass only the workspace GUID.'
    );
  }
  return errors;
}

export interface InitFlagValidation {
  /** Hard errors — caller should report and exit. */
  errors: string[];
  /** Soft warnings — caller should log but continue. */
  warnings: string[];
  /**
   * Normalized dialect:
   *   - undefined: input had no dialect
   *   - lowercased valid value: input was recognized
   *   - DatabaseDialect.MsSql: input was invalid; fallback applied (warnings populated)
   */
  normalizedDialect?: string;
}

const VALID_DIALECTS: readonly string[] = [
  DatabaseDialect.MsSql,
  DatabaseDialect.PostgreSql,
];

export function validateInitFlags(opts: InitFlagInputs): InitFlagValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  errors.push(
    ...validateWorkspaceFlagSet({
      workspace: opts.workspace,
      workspaceId: opts.workspaceId,
      workspaceUri: opts.workspaceUri,
    })
  );

  if (opts.baseApiUrl && opts.workspaceUri) {
    errors.push('--base-api-url and --workspace-uri are mutually exclusive.');
  }

  if (opts.templateName && !opts.template) {
    errors.push(
      '--template-name requires --template <url> pointing to a multi-template source'
    );
  }

  let normalizedDialect: string | undefined;
  if (opts.dialect !== undefined) {
    const lowered = opts.dialect.toLowerCase();
    if (VALID_DIALECTS.includes(lowered)) {
      normalizedDialect = lowered;
    } else {
      warnings.push(
        `Invalid dialect '${opts.dialect}' provided. Valid options are: ${VALID_DIALECTS.join(', ')}`
      );
      warnings.push(
        `Falling back to default dialect: ${DatabaseDialect.MsSql}`
      );
      normalizedDialect = DatabaseDialect.MsSql;
    }
  }

  return { errors, warnings, normalizedDialect };
}

// ── selectTemplateSource ──────────────────────────────────────────────────

export interface RegistryEntryRef {
  name: string;
  url: string;
  ref?: string;
  path?: string;
  templateName?: string;
  default?: boolean;
  firstClass?: boolean;
}

export interface SelectTemplateSourceInput {
  template?: string;
  templateName?: string;
  listTemplates?: boolean;
  fromTemplate?: boolean;
}

export type TemplateSourceDecision =
  | { kind: 'list-templates' }
  | { kind: 'error'; message: string }
  | {
      kind: 'external';
      url: string;
      registryPath?: string;
      templateName?: string;
      fallbackBundledName?: string;
    }
  | { kind: 'local'; path: string; templateName?: string }
  | { kind: 'bundled'; name: string }
  | { kind: 'interactive' };

/**
 * Build the git clone URL for a registry entry. Threads `ref` via the `#`
 * suffix that parseGitUrl recognizes. If the entry's URL already contains a
 * `#`, the existing fragment wins (we don't try to merge or override).
 */
export function buildRegistryCloneUrl(entry: RegistryEntryRef): string {
  if (!entry.ref) {
    return entry.url;
  }
  if (entry.url.includes('#')) {
    return entry.url;
  }
  return `${entry.url}#${entry.ref}`;
}

/**
 * Pure dispatch decision for `rayfin init` based on the flags and the set
 * of available template sources. No I/O.
 */
export function selectTemplateSource(
  input: SelectTemplateSourceInput,
  bundledTemplateNames: ReadonlyArray<string>,
  registryEntries: ReadonlyArray<RegistryEntryRef>
): TemplateSourceDecision {
  if (input.listTemplates) {
    return { kind: 'list-templates' };
  }

  if (input.templateName && !input.template) {
    return {
      kind: 'error',
      message:
        '--template-name requires --template <url> pointing to a multi-template source',
    };
  }

  if (input.template && !input.fromTemplate) {
    if (isGitUrl(input.template)) {
      return {
        kind: 'external',
        url: input.template,
        templateName: input.templateName,
      };
    }

    if (isLocalPath(input.template)) {
      return {
        kind: 'local',
        path: input.template,
        templateName: input.templateName,
      };
    }

    const registryMatch = registryEntries.find(
      (r) => r.name === input.template
    );

    const isBundled = bundledTemplateNames.includes(input.template);
    if (registryMatch?.firstClass === true) {
      if (
        input.templateName &&
        input.templateName !== registryMatch.templateName
      ) {
        return {
          kind: 'error',
          message: `--template-name cannot override first-class template '${input.template}'. This alias is pinned to registry template '${registryMatch.templateName ?? input.template}'.`,
        };
      }

      return {
        kind: 'external',
        url: buildRegistryCloneUrl(registryMatch),
        registryPath: registryMatch.path,
        templateName: registryMatch.templateName,
        fallbackBundledName: isBundled ? input.template : undefined,
      };
    }

    if (registryMatch && !isBundled) {
      // path scopes the clone to a sub-tree of the repo; templateName
      // selects an entry within that sub-tree's manifest. Both can compose:
      // path = 'apps/web' + templateName = 'starter' means "use the
      // 'starter' entry from apps/web/rayfin-template.yml".
      return {
        kind: 'external',
        url: buildRegistryCloneUrl(registryMatch),
        registryPath: registryMatch.path,
        templateName: input.templateName ?? registryMatch.templateName,
      };
    }

    // Fall through: treat as bundled name (handler reports if unknown).
    return { kind: 'bundled', name: input.template };
  }

  return { kind: 'interactive' };
}

// ── safeTemplateNameForTelemetry ──────────────────────────────────────────

/**
 * Reduce a resolved bundled-template name to a safe, non-identifying value
 * for the `rayfin.template_name` telemetry field.
 *
 * `selectTemplateSource` falls through to `kind: 'bundled'` for any
 * `--template` token that isn't a git URL, local path, or registry match,
 * so recording it verbatim would leak user-supplied content and give the
 * field unbounded cardinality. Real built-in names pass through; anything
 * else buckets to `'unknown-bundled'`.
 */
export function safeTemplateNameForTelemetry(
  name: string,
  bundledTemplateNames: ReadonlyArray<string>
): string {
  return bundledTemplateNames.includes(name) ? name : 'unknown-bundled';
}

// ── planServiceDirectoryScaffolding ────────────────────────────────────────

/**
 * Structural subset of `rayfin.yml` this helper needs: the optional
 * `services.<name>.path` overrides that relocate a service's source out of the
 * default `rayfin/<service>/` location. `RayfinConfig` is assignable to this.
 */
export interface ServiceScaffoldConfigLike {
  services?: {
    data?: { path?: string } | undefined;
    storage?: { path?: string } | undefined;
    functions?: { path?: string } | undefined;
  };
}

/** Inputs to {@link planServiceDirectoryScaffolding}. */
export interface ServiceScaffoldPlanInput {
  /** Enabled service names (e.g. `['auth', 'data', 'functions']`). */
  enabledServices: ReadonlyArray<string>;
  /** Successfully parsed rayfin.yml. */
  config: ServiceScaffoldConfigLike;
  /** True during the hidden `rayfin init --from-template` sync. */
  fromTemplate: boolean;
  /** True when a `rayfin/functions/` directory already exists on disk. */
  functionsDefaultDirExists: boolean;
}

/** Which default `rayfin/<service>/` directories init should lay down. */
export interface ServiceScaffoldPlan {
  createDataDir: boolean;
  createStorageDir: boolean;
  scaffoldFunctions: boolean;
}

/**
 * Decide which default `rayfin/<service>/` directories `rayfin init` should
 * create/scaffold. Pure decision logic, no I/O.
 *
 * A service whose `rayfin.yml` block declares an explicit `path` (e.g. a
 * multi-package template that keeps `data`/`functions`/`storage` under
 * `packages/`) already owns its source at that path. In that case init must
 * NOT create an empty `rayfin/<service>/` directory or scaffold a stray
 * default functions app on top of it — doing so is the bug this guards
 * against. The functions scaffold is additionally skipped when the template
 * already shipped a `rayfin/functions/` directory (`fromTemplate` sync).
 */
export function planServiceDirectoryScaffolding(
  input: ServiceScaffoldPlanInput
): ServiceScaffoldPlan {
  const { enabledServices, config, fromTemplate, functionsDefaultDirExists } =
    input;

  // Trim before testing: config validation does not reject a blank/whitespace
  // `path`, and a whitespace-only value is truthy — it would suppress the
  // default dir while pointing at nothing real. Treat blank as "no override".
  const dataPath = config.services?.data?.path?.trim();
  const storagePath = config.services?.storage?.path?.trim();
  const functionsPath = config.services?.functions?.path?.trim();

  return {
    createDataDir: enabledServices.includes('data') && !dataPath,
    createStorageDir: enabledServices.includes('storage') && !storagePath,
    scaffoldFunctions:
      enabledServices.includes('functions') &&
      !functionsPath &&
      !(fromTemplate && functionsDefaultDirExists),
  };
}
