import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  fabricSemanticModel,
  parseArrowStream,
  resolveTarget,
  toQueryResult,
} from '@microsoft/rayfin-connector-fabric-semanticmodel';
import type { FabricSemanticModelTabularResponse } from '@microsoft/rayfin-connector-fabric-semanticmodel';
import {
  createConnectorsApi,
  isConnectorError,
  type ConnectorConfig,
  type ConnectorErrorCategory,
} from '@microsoft/rayfin-connectors';
import { ApiClient, NetworkError } from '@microsoft/rayfin-lib';
import {
  formatHttpStatus,
  getHttpErrorRecoveryHint,
} from '@microsoft/rayfin-tools-common/_internal';
import type { ConnectorEntry } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  CONNECTOR_CATALOG,
  normalizeConnectorsBlock,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { Command, Option } from 'commander';

import { resolveDbTokenTarget } from '../../auth/db-token.js';
import { getRayfinAuth } from '../../auth/index.js';
import {
  audienceMatches,
  readTokenAudience as readAmbientTokenAudience,
} from '../../auth/token-audience.js';
import { getFabricSettings, MONIKER_HEADER } from '../../config/constants.js';
import { CliHandledError } from '../../errors.js';
import { hasAmbientToken } from '../../utils/ambient-env.js';
import { loadRayfinConfig } from '../../utils/config-utils.js';
import { failedEnvelopeMessage } from '../../utils/connector-envelope.js';
import { formatBytes } from '../../utils/format-utils.js';
import { fabricFetch } from '../../utils/http-client.js';
import {
  DEFAULT_MAX_INLINE_BYTES,
  prepareInvokeOutput,
  type InvokeOutputPlacement,
} from '../../utils/invoke-result-file.js';
import {
  emitJson,
  emitJsonError,
  modeError,
  modeLog,
  modeWarn,
  resolveOutputMode,
  resolveRootOutputFlags,
  type OutputMode,
} from '../../utils/output-mode.js';
import { renderPlainOutput } from '../../utils/plain-output.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import {
  getActiveDeploymentEnvVars,
  getRemoteAuthorizationHeader,
  getRemoteEndpoint,
} from '../../utils/remote-endpoint-utils.js';

/**
 * Reads the `aud` claim from a bearer token.
 *
 * Returns `undefined` for opaque or malformed tokens so callers skip the
 * audience check rather than reject a token they simply cannot inspect.
 */
function readTokenAudience(header: string): string | undefined {
  return readAmbientTokenAudience(header);
}

function isPowerBiAudience(audience: string, expected: string): boolean {
  return audienceMatches(audience, expected);
}

function toFailurePayloadMessage(payload: unknown): string {
  if (typeof payload === 'string') {
    const text = payload.trim();
    return text.length > 0 ? text : 'No response body was returned.';
  }

  return JSON.stringify(payload);
}

/**
 * Error detail carried by a failed connector envelope.
 *
 * The `fabric-semanticmodel` direct path never throws: a non-2xx response from
 * Power BI is converted into `{ status: 'Failed', output: { responseError } }`
 * so the CLI and standalone paths return the same shape. A resolved promise
 * therefore does not mean the operation succeeded, and the CLI has to inspect
 * the envelope before reporting success.
 */
interface ConnectorResponseError {
  message?: string;
  category?: string;
  code?: string;
  details?: string;
  recoveryHint?: string;
}

/**
 * Remediation for each category in the shared connector error contract.
 *
 * Derived from the category rather than matched out of the message, so a
 * connector that classifies its failures gets the right hint without the CLI
 * knowing anything about the service behind it.
 */
const CATEGORY_RECOVERY_HINTS: Record<ConnectorErrorCategory, string> = {
  network:
    'The request never reached the service. Check connectivity and any proxy settings, then retry.',
  api: 'The service rejected the request. Confirm you are signed in and have access to the resource.',
  query:
    'The service ran the operation and reported an error. Fix the query and retry.',
  overflow:
    'The result exceeded a size cap. Lower resultSetRowCountLimit, or narrow the query.',
  unknown:
    'Retry with --verbose to see the full response, then check permissions and query syntax.',
};

/**
 * Narrow an arbitrary category string to one the table actually defines.
 *
 * `category` crosses a JSON boundary typed only as `string`, so it can be any
 * value at runtime. The check is `hasOwnProperty` rather than `in` because
 * `in` walks the prototype chain: `'toString' in CATEGORY_RECOVERY_HINTS` is
 * true, and the lookup would then hand a function back to the renderer.
 */
function isKnownCategory(category: string): category is ConnectorErrorCategory {
  return Object.prototype.hasOwnProperty.call(
    CATEGORY_RECOVERY_HINTS,
    category
  );
}

/**
 * Codes and messages that mean the caller lacks permission on the semantic
 * model, as opposed to a malformed query or a transient service failure.
 *
 * Only reached for a connector that has not adopted the error contract and so
 * carries no category to derive a hint from. The envelope carries no numeric
 * HTTP status, so this matches both the Power BI error code
 * (`PowerBINotAuthorizedException`) and the numeric-string fallback.
 */
const PERMISSION_FAILURE_PATTERN =
  /(?:un|not)[_\s-]?authoriz|forbidden|access\s*denied|invalid[_\s-]?token|token[_\s-]?expired|\b40[13]\b/i;

const PERMISSION_RECOVERY_HINT =
  'Sign in again, and confirm you have at least Viewer access to the workspace/semantic model (Builder access if you also need to query it).';

const GENERIC_RECOVERY_HINT =
  'Check semantic model permissions and query syntax, then retry with --verbose.';

/** Connector-neutral hint, for failures read straight off a workload envelope. */
const ENVELOPE_RECOVERY_HINT =
  'Check connector configuration and operation input, then retry with --verbose.';

/**
 * Pull the error out of a failed connector result, or return `undefined` when
 * the operation succeeded (or returned a shape without a status envelope).
 *
 * Connectors that normalise in their `invoke` middleware resolve to the shared
 * error contract; those that do not still return the raw envelope, where
 * `status: 'Failed'` is the failure signal.
 *
 * `requestId` is carried alongside the error because it is stamped on the
 * result rather than the error, and it is the only correlation handle to hand
 * the service team.
 */
function readConnectorFailure(
  output: unknown
): { error: ConnectorResponseError; requestId?: string } | undefined {
  if (typeof output !== 'object' || output === null) {
    return undefined;
  }

  const result = output as {
    status?: unknown;
    requestId?: unknown;
  };

  const rawRequestId =
    result.requestId ??
    (output as { output?: { requestId?: unknown } }).output?.requestId;
  const requestId =
    typeof rawRequestId === 'string' && rawRequestId.trim().length > 0
      ? rawRequestId
      : undefined;

  if (isConnectorError(output)) {
    return { error: output.error, ...(requestId ? { requestId } : {}) };
  }

  // A result that declares failure but carries no usable error still failed,
  // and must not fall through to be read as a success.
  if (result.status === 'error') {
    return { error: {}, ...(requestId ? { requestId } : {}) };
  }

  // `connector-kusto` has not adopted the contract and reports failure as an
  // envelope status string, so without this a failed Kusto query exits 0.
  const envelopeStatus = result.status;
  if (
    typeof envelopeStatus === 'string' &&
    envelopeStatus.toLowerCase() === 'failed'
  ) {
    const responseError = (output as { output?: { responseError?: unknown } })
      .output?.responseError;
    if (typeof responseError === 'object' && responseError !== null) {
      return {
        error: responseError as ConnectorResponseError,
        ...(requestId ? { requestId } : {}),
      };
    }

    // Kusto puts its detail in a top-level `errors[]` and has no
    // `responseError`, so read the envelope rather than return an empty error.
    // The hint is explicit because the uncategorised default talks about
    // semantic models.
    const envelopeDetail = failedEnvelopeMessage(output);
    return {
      error: {
        ...(envelopeDetail ? { message: envelopeDetail } : {}),
        recoveryHint: ENVELOPE_RECOVERY_HINT,
      },
      ...(requestId ? { requestId } : {}),
    };
  }

  return undefined;
}

/** Render a failed envelope as the message + recovery hint pair the CLI prints. */
function describeConnectorFailure(error: ConnectorResponseError): {
  message: string;
  recovery: string;
} {
  const detail =
    error.message?.trim() || 'The connector returned a failed response.';
  const code = error.code?.trim() ?? '';
  const numericStatus = /^\d{3}$/.test(code) ? Number(code) : undefined;
  const label =
    numericStatus !== undefined
      ? formatHttpStatus(numericStatus)
      : code || 'connector error';

  const message = `Connector invoke failed (${label}): ${detail}`;

  // The connector knows something the category cannot express, so it wins.
  const explicitHint = error.recoveryHint?.trim();
  if (explicitHint) {
    return { message, recovery: explicitHint };
  }

  const category = error.category?.trim();
  if (category !== undefined && isKnownCategory(category)) {
    return { message, recovery: CATEGORY_RECOVERY_HINTS[category] };
  }

  // Uncategorised, so guess from the message. Only reached for a connector
  // that has not adopted the contract.
  if (PERMISSION_FAILURE_PATTERN.test(`${code} ${detail}`)) {
    return { message, recovery: PERMISSION_RECOVERY_HINT };
  }

  return {
    message,
    recovery:
      numericStatus !== undefined
        ? getHttpErrorRecoveryHint(numericStatus, GENERIC_RECOVERY_HINT)
        : GENERIC_RECOVERY_HINT,
  };
}

/**
 * Emit a successful invoke payload for the non-JSON output modes.
 *
 * `--output plain` used to be accepted and then ignored: both call sites
 * printed `JSON.stringify(payload, null, 2)` through `modeLog`, which routes
 * to stderr in plain mode, so `plain` was indistinguishable from `json`
 * except for where the bytes landed. Plain now renders a human-readable
 * layout on stdout so it can be read or piped, while `interactive` keeps the
 * pretty-printed JSON it has always shown.
 */
function emitInvokeOutput(
  mode: OutputMode,
  statusLine: string,
  payload: unknown,
  placement?: InvokeOutputPlacement
): void {
  // The status line is progress chatter, so it stays on modeLog — stderr in
  // plain mode, which keeps stdout to just the payload.
  modeLog(mode, statusLine);

  if (mode === 'plain') {
    // A string payload is already human-readable, so it goes out verbatim
    // rather than through the key/value renderer.
    const rendered =
      typeof payload === 'string' ? payload : renderPlainOutput(payload);
    if (rendered.length > 0) {
      console.log(rendered);
    }
  } else {
    // Interactive keeps the pretty-printed JSON it has always shown, including
    // the surrounding quotes on a string payload. Unquoting only in plain mode
    // is what keeps `--output plain` pipeable without changing what existing
    // interactive callers see.
    modeLog(mode, JSON.stringify(payload, null, 2));
  }

  if (placement) {
    emitPlacementNotice(mode, placement);
  }
}

/**
 * Tell the reader that what they just saw is not the whole result, and where
 * the rest is.
 *
 * Routed through `modeLog`/`modeWarn` rather than stdout so a `--output plain`
 * pipe still carries only the payload; a machine consumer reads `outputFile`
 * off the `--json` envelope instead.
 */
function emitPlacementNotice(
  mode: OutputMode,
  placement: InvokeOutputPlacement
): void {
  const size =
    placement.outputBytes !== undefined
      ? ` (${formatBytes(placement.outputBytes)})`
      : '';
  const shown =
    placement.previewItems && placement.previewItems > 0
      ? `Only the first ${placement.previewItems} entries of each list are shown above`
      : 'No preview could be shown';

  if (placement.spillError) {
    modeWarn(
      mode,
      `Result${size} was too large to print and could not be written to disk: ${placement.spillError}\n` +
        `   ${shown}. Narrow the query, or pass --output-file with a writable path.`
    );
    return;
  }

  if (!placement.outputFile) {
    return;
  }

  modeLog(mode, `Full result${size} written to ${placement.outputFile}`);
  if (placement.outputTruncated) {
    modeLog(mode, `   ${shown} — read that file instead of re-running.`);
  }
}

/**
 * Render a successful invoke, spilling the payload to a file first when it is
 * too large to belong in a terminal (or an agent's context window).
 *
 * Shared by both transports so the envelope, the size threshold, and the
 * pointer fields cannot drift between the direct and deployed routes.
 */
async function emitInvokeSuccess(options: {
  mode: OutputMode;
  connector: string;
  operation: string;
  payload: unknown;
  maxInlineBytes: number;
  projectRoot: string;
  outputFile?: string;
}): Promise<void> {
  const { mode, connector, operation, payload, outputFile } = options;

  let placement: InvokeOutputPlacement;
  try {
    placement = await prepareInvokeOutput({
      payload,
      connector,
      operation,
      maxInlineBytes: options.maxInlineBytes,
      projectRoot: options.projectRoot,
      ...(outputFile ? { outputFile } : {}),
    });
  } catch (error) {
    // Only an explicit `--output-file` throws; an automatic spill degrades to
    // a preview rather than failing an invoke that otherwise succeeded.
    failHandled(
      mode,
      `Could not write the result to ${outputFile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'Point --output-file at a writable path, or drop the flag to use the default location under rayfin/.temp/invoke-results.'
    );
  }

  const envelope = {
    status: 'ok' as const,
    connector,
    operation,
    output: placement.output,
    ...(placement.outputFile ? { outputFile: placement.outputFile } : {}),
    ...(placement.outputBytes !== undefined
      ? { outputBytes: placement.outputBytes }
      : {}),
    ...(placement.outputTruncated ? { outputTruncated: true } : {}),
    ...(placement.previewItems !== undefined
      ? { previewItems: placement.previewItems }
      : {}),
  };

  if (mode === 'json') {
    emitJson(envelope);
    return;
  }

  emitInvokeOutput(
    mode,
    `✅ Invoked ${connector}.${operation}`,
    placement.output,
    placement
  );
}

/**
 * Validate `--max-inline-bytes`, which has to be a byte count rather than an
 * arbitrary number: a negative or fractional threshold would silently never
 * (or always) trigger.
 */
function parseMaxInlineBytes(
  raw: string | undefined,
  mode: OutputMode
): number {
  if (raw === undefined) {
    return DEFAULT_MAX_INLINE_BYTES;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    failHandled(
      mode,
      `Invalid --max-inline-bytes value: ${raw}.`,
      'Pass a non-negative whole number of bytes, or 0 to always print the result inline.'
    );
  }

  return value;
}

function resolveAllowedOperation(
  operation: string,
  allowedOperations: readonly string[]
): string | null {
  const requested = operation.toLowerCase();
  const match = allowedOperations.find(
    (candidate) => candidate.toLowerCase() === requested
  );
  return match ?? null;
}

function failHandled(
  mode: OutputMode,
  message: string,
  recovery?: string,
  requestId?: string,
  connectorError?: ConnectorResponseError
): never {
  if (mode === 'json') {
    // Only publish contract fields, never arbitrary response or exception data.
    // Coerce scalars (a number/boolean survives the deployed JSON passthrough
    // instead of being dropped) and JSON-encode structured values rather than
    // discarding them silently. `recoveryHint` is deliberately excluded: the
    // top-level `recovery` string already carries it, and a CLI-fabricated
    // default (e.g. the envelope hint) would otherwise masquerade here as a
    // connector-supplied field.
    const encode = (value: unknown): string => {
      if (typeof value !== 'object') return String(value);
      // `failHandled` also runs on arbitrary thrown objects (the `catch` path),
      // where `details` can carry a circular reference. Never let the handler
      // itself throw and turn a clean exit-1 into an unhandled crash; the `??`
      // also covers `JSON.stringify` returning `undefined`.
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    };
    const source = connectorError as Record<string, unknown> | undefined;
    const structuredError = Object.fromEntries(
      (['message', 'category', 'code', 'details'] as const)
        .map((key) => [key, source?.[key]] as const)
        // Drop empty as well as absent fields so the deployed passthrough path
        // agrees with the SDK-normalised path and the documented contract.
        .filter(([, value]) => value != null && value !== '')
        .map(([key, value]) => [key, encode(value)])
    );
    const extra = {
      ...(recovery ? { recovery } : {}),
      ...(requestId ? { requestId } : {}),
      ...(Object.keys(structuredError).length > 0
        ? { connectorError: structuredError }
        : {}),
    };
    return emitJsonError(
      mode,
      message,
      Object.keys(extra).length > 0 ? extra : undefined
    );
  }

  const suffix = requestId ? `\n   Request ID: ${requestId}` : '';
  modeError(
    mode,
    recovery
      ? `❌ ${message}\n   ${recovery}${suffix}`
      : `❌ ${message}${suffix}`
  );
  throw new CliHandledError(message);
}

function parseJsonInput(raw: string, mode: OutputMode): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    failHandled(
      mode,
      'Invalid JSON passed to --input.',
      'Pass valid JSON, for example: --input \'{"query":"EVALUATE TOPN(10, Sales)"}\''
    );
  }
}

function readJsonInputFile(
  filePath: string,
  projectRoot: string,
  mode: OutputMode
): unknown {
  const root = resolve(projectRoot);
  const absolute = resolve(root, filePath);

  if (absolute !== root && !absolute.startsWith(root + sep)) {
    failHandled(
      mode,
      `Input file must be inside the project: ${filePath}`,
      'Use a relative path under your project root.'
    );
  }

  if (!existsSync(absolute)) {
    failHandled(
      mode,
      `Input file not found: ${filePath}`,
      'Verify the path and retry.'
    );
  }

  return parseJsonInput(readFileSync(absolute, 'utf8'), mode);
}

function resolveConnector(
  connectors: ConnectorEntry[],
  name: string,
  mode: OutputMode
): ConnectorEntry {
  const requested = name.toLowerCase();
  const connector = connectors.find(
    (entry) => entry.name.toLowerCase() === requested
  );
  if (!connector) {
    const known = connectors.map((entry) => entry.name).join(', ');
    failHandled(
      mode,
      `Connector "${name}" is not declared in rayfin.yml.`,
      known.length > 0
        ? `Use one of: ${known}.`
        : 'Run `rayfin connector add` to declare a connector first.'
    );
  }

  return connector;
}

export const connectorInvokeCommand = new Command('invoke')
  .description('Invoke an operation on a configured connector')
  .argument('[connector-name]', 'Connector name declared in rayfin.yml')
  .argument(
    '[operation]',
    'Connector operation to invoke (for example, executeQuery)'
  )
  .option('--name <name>', 'Connector name declared in rayfin.yml')
  .option(
    '--operation <operation>',
    'Connector operation to invoke (for example, executeQuery)'
  )
  .option('--input <json>', 'JSON payload for the operation input')
  .option('--file <path>', 'Path to a JSON file with the operation input')
  .addOption(
    new Option(
      '--transport <mode>',
      'Which path to invoke through. `auto` (default) picks per connector type; `deployed` forces the deployed BaaS route, which needs a Rayfin app-session token in RAYFIN_TOKEN - a normal `rayfin login` cannot mint one.'
    ).choices(['auto', 'deployed'])
  )
  .option('-v, --verbose', 'Enable verbose output', false)
  .addOption(
    new Option('--output <mode>', 'Output format for this command').choices([
      'interactive',
      'plain',
      'json',
    ])
  )
  .option(
    '--output-file <path>',
    'Write the full result to this file. The result is still shown inline unless it exceeds --max-inline-bytes.'
  )
  .option(
    '--max-inline-bytes <bytes>',
    `Write the result to a file and show only a preview when its serialized size exceeds this many bytes. Use 0 to always show it inline (default: ${DEFAULT_MAX_INLINE_BYTES}).`
  )
  .option('--json', 'Output a machine-readable JSON object', false)
  .action(async function (
    this: Command,
    connectorName: string | undefined,
    operationArg: string | undefined,
    options: {
      name?: string;
      operation?: string;
      input?: string;
      file?: string;
      transport?: 'auto' | 'deployed';
      verbose?: boolean;
      output?: OutputMode;
      outputFile?: string;
      maxInlineBytes?: string;
      json?: boolean;
    }
  ) {
    const root = resolveRootOutputFlags(this);
    const mode = resolveOutputMode({
      json: Boolean(options.json) || root.json,
      output: options.output ?? root.output,
    });
    const verbose = Boolean(options.verbose) || root.verbose;

    // `--json` promises exactly one JSON object on stdout, so verbose
    // narration cannot coexist with it.
    if (mode === 'json' && verbose) {
      failHandled(
        mode,
        'Cannot combine --verbose with --json.',
        'Drop --verbose, or use --output plain to see progress detail.'
      );
    }

    const maxInlineBytes = parseMaxInlineBytes(options.maxInlineBytes, mode);

    const name = options.name ?? connectorName;
    const operation = options.operation ?? operationArg;

    if (!name || !operation) {
      failHandled(
        mode,
        'Missing required connector invoke arguments.',
        '🧭 Usage: rayfin connector invoke <connector-name> <operation> --input \'{"query":"EVALUATE TOPN(1, testmodel)"}\'\n   📄 Or: rayfin connector invoke <connector-name> <operation> --file ./payload.json'
      );
    }

    const filePath = options.file;

    if (options.input && filePath) {
      failHandled(
        mode,
        'Choose exactly one payload source.',
        "✋ Use either --input '<json>' or --file ./payload.json (not both)."
      );
    }

    if (!options.input && !filePath) {
      failHandled(
        mode,
        'Missing payload input.',
        "💡 Provide --input '<json>' or --file ./payload.json."
      );
    }

    let projectRoot: string;
    let config: { connectors?: ConnectorEntry[] };
    try {
      projectRoot = findRayfinProjectRoot(process.cwd(), {
        silent: true,
      });
      config = loadRayfinConfig(projectRoot, { silent: true }) as {
        connectors?: ConnectorEntry[];
      };
    } catch (error) {
      // A raw throw here would escape as a stack trace and break the
      // single-JSON-object contract `--json` promises.
      failHandled(
        mode,
        error instanceof Error ? error.message : String(error),
        'Run this command from inside a Rayfin project (a directory containing `rayfin/rayfin.yml`).'
      );
    }

    const connectors = normalizeConnectorsBlock(config.connectors) ?? [];

    if (connectors.length === 0) {
      failHandled(
        mode,
        'No connectors declared in rayfin.yml.',
        'Run `rayfin connector add` first.'
      );
    }

    const connector = resolveConnector(connectors, name, mode);
    const catalogMeta = CONNECTOR_CATALOG[connector.type];
    const configuredOps = connector.operations?.map((entry) => entry.name);
    const allowedOps =
      configuredOps && configuredOps.length > 0
        ? configuredOps
        : [...catalogMeta.allowedOperations];

    const resolvedOperation = resolveAllowedOperation(operation, allowedOps);
    if (!resolvedOperation) {
      failHandled(
        mode,
        `Operation "${operation}" is not allowed for connector "${name}" (type=${connector.type}).`,
        `Allowed operations: ${allowedOps.join(', ')}.`
      );
    }

    const input = filePath
      ? readJsonInputFile(filePath, projectRoot, mode)
      : options.input
        ? parseJsonInput(options.input, mode)
        : null;

    // Route through the shared `@microsoft/rayfin-connectors` invoke
    // middleware (see HostEnvironment / detectHost()), which always resolves
    // the CLI's own process to the 'cli' host, never 'standalone'. Only a
    // deployed 'standalone' app routes semantic-model invokes through the
    // BaaS `/connector-invoke/<name>` transport; the CLI calls Fabric/Power
    // BI directly under the developer's own identity, whether or not
    // `rayfin up` has been run.
    //
    // `--transport deployed` opts out of that shortcut. The two routes reach
    // the same model by different means, and only the deployed one crosses
    // BaaS → FuncSet → delegated OBO — the segment a browser uses and the CLI
    // otherwise never touches. A CLI probe that succeeds on the direct route
    // therefore says nothing about whether the deployed app will work, which
    // is exactly the false confidence this flag exists to remove.
    const forceDeployed = options.transport === 'deployed';
    if (connector.type === 'fabric-semanticmodel' && !forceDeployed) {
      // The runtime's CLI branch only engages when it can resolve a concrete
      // {workspaceId, itemId} target. Without one it silently falls through
      // to the BaaS transport, which fails confusingly outside a deployed
      // app, so validate up front and fail with an actionable message.
      const workspaceId = connector.config?.workspaceId;
      const itemId = connector.config?.itemId;
      const target =
        workspaceId && itemId
          ? resolveTarget({ workspaceId, itemId })
          : undefined;

      if (!target) {
        failHandled(
          mode,
          `Connector "${connector.name}" is missing workspaceId/itemId in rayfin.yml.`,
          "Add both under the connector's `config:` block, or re-run `rayfin connector add` to populate them."
        );
      }

      const hasAmbient = hasAmbientToken();

      // Pick the Power BI scope/audience for the environment the Fabric API
      // base URL points at, so INT rings mint an INT-audience token and
      // production mints a production one. Resolved once and reused for both
      // token acquisition and the local audience guard.
      const fabricApiBaseUrl = getFabricSettings().fabricApiBaseUrl;
      const { scopes: powerBiScopes, audience: expectedAudience } =
        resolveDbTokenTarget(fabricApiBaseUrl);

      // A cached account does not guarantee a token for the Power BI scope can
      // be acquired without user interaction: when the scope still needs
      // consent the underlying auth falls back to browser/device-code login and
      // writes prompts to stdout, which would corrupt the single JSON object
      // `--json` promises. In JSON mode acquire silently and translate any
      // failure into one handled JSON error instead.
      let authorization: string;
      if (hasAmbient || mode !== 'json') {
        // Acquire the token eagerly so an audience mismatch surfaces as its own
        // message. Otherwise a wrong-audience token 401s inside the connector
        // and gets reported as a tenant permission problem.
        authorization = await getRemoteAuthorizationHeader(powerBiScopes);
      } else {
        try {
          const auth = await getRayfinAuth();
          const { token } = await auth.acquireToken(powerBiScopes, {
            silentOnly: true,
          });
          authorization = `Bearer ${token}`;
        } catch {
          // `rayfin login` only requests the Fabric scope, so it never grants
          // consent for the Power BI scope this command needs. The interactive
          // branch above does grant it, so the recovery is to drop `--json`.
          failHandled(
            mode,
            'Not signed in, or no Power BI token could be acquired without an interactive prompt.',
            `Re-run without \`--json\` to complete Power BI consent interactively, or set RAYFIN_TOKEN to an access token for ${expectedAudience}, then retry.`
          );
        }
      }

      const audience = readTokenAudience(authorization);
      // An ambient token whose audience cannot be read cannot be verified, and
      // the Power BI query endpoint requires an inspectable Entra access token.
      // Reject locally instead of letting the request 401 and be reported as a
      // workspace or model permission problem.
      if (hasAmbient && !audience) {
        failHandled(
          mode,
          'RAYFIN_TOKEN could not be decoded as a JWT, so its audience cannot be verified.',
          `Set RAYFIN_TOKEN to an access token for ${expectedAudience}, or unset it and run \`rayfin login\`, then retry.`
        );
      }
      if (audience && !isPowerBiAudience(audience, expectedAudience)) {
        failHandled(
          mode,
          `Access token has the wrong audience for the Power BI query API (got ${audience}, expected ${expectedAudience}).`,
          hasAmbient
            ? `RAYFIN_TOKEN is passed through unchanged regardless of the scopes this command requests. Unset it, or set it to a token for ${expectedAudience}, then retry.`
            : `Re-run without \`--json\` so the sign-in prompt can grant consent for ${expectedAudience}, or set RAYFIN_TOKEN to an access token for that audience, then retry.`
        );
      }

      const apiClient = new ApiClient({
        baseUrl: '',
        publishableKey: 'rayfin-cli',
      });
      const connectorConfig: ConnectorConfig = {
        connector: connector.type,
      };
      const connectorsApi = createConnectorsApi(
        apiClient,
        { [connector.name]: connectorConfig },
        {
          [connector.name]: fabricSemanticModel({
            target,
            endpoints: { fabricApi: fabricApiBaseUrl },
            // `ctx.http` carries a Rayfin-audience token; the Power BI
            // `executeQueries` endpoint needs its own audience. Returning a
            // value here sets `Authorization` explicitly, which wins because
            // `ApiClient.prepareHeaders` only injects its own token when the
            // header is absent. A returned `Bearer ...` header is passed
            // through unchanged.
            getToken: () => Promise.resolve(authorization),
          }),
        },
        { type: 'cli' }
      );

      const client = connectorsApi[connector.name] as unknown as Record<
        string,
        (input?: unknown) => Promise<unknown>
      >;

      if (verbose) {
        modeLog(mode, `Invoking ${name}.${operation}`);
      }

      let output: unknown;
      try {
        output = await client[resolvedOperation](input);
      } catch (error) {
        const failure = readConnectorFailure(error);
        if (failure) {
          const { message, recovery } = describeConnectorFailure(failure.error);
          failHandled(
            mode,
            message,
            recovery,
            failure.requestId,
            failure.error
          );
        }

        // Safety net only. The semantic-model path resolves with a failed
        // envelope rather than throwing, so this fires for genuine transport
        // faults surfaced by `ApiClient.requestRaw` (DNS, TLS, socket).
        if (error instanceof NetworkError) {
          const statusLabel =
            typeof error.status === 'number'
              ? formatHttpStatus(error.status)
              : 'network error';
          failHandled(
            mode,
            `Connector invoke failed (${statusLabel}): ${error.message}`,
            typeof error.status === 'number'
              ? getHttpErrorRecoveryHint(error.status, GENERIC_RECOVERY_HINT)
              : GENERIC_RECOVERY_HINT
          );
        }

        failHandled(
          mode,
          `Connector invoke failed: ${error instanceof Error ? error.message : String(error)}`,
          GENERIC_RECOVERY_HINT
        );
      }

      // A resolved promise is not success. The connector reports a Power BI
      // failure (expired token, missing Build permission, throttle, a DAX
      // syntax error) inside its response, so it has to be inspected before the
      // CLI claims the query worked — otherwise a permission error exits 0.
      const failure = readConnectorFailure(output);
      if (failure) {
        const { message, recovery } = describeConnectorFailure(failure.error);
        // The RFC requires surfacing the service-supplied request id so a
        // failure can be traced back to the Power BI side.
        failHandled(mode, message, recovery, failure.requestId, failure.error);
      }

      await emitInvokeSuccess({
        mode,
        connector: connector.name,
        operation: resolvedOperation,
        payload: output,
        maxInlineBytes,
        projectRoot,
        ...(options.outputFile ? { outputFile: options.outputFile } : {}),
      });
      return;
    }

    const authorizationHeader = await getRemoteAuthorizationHeader().catch(() =>
      failHandled(
        mode,
        'Authentication is required for connector invoke.',
        'Run `rayfin login` and retry.'
      )
    );

    const itemEndpoint = getRemoteEndpoint();
    const deployment = getActiveDeploymentEnvVars();

    if (!itemEndpoint || !deployment?.rayfinItemId) {
      failHandled(
        mode,
        'No remote endpoint configured.',
        'Run `rayfin up` first so invoke can target a deployed Rayfin item.'
      );
    }

    // Two endpoints on two services, and only one is the path a browser takes.
    //
    //   default   {fabricApiBaseUrl}/workspaces/…/appBackends/…
    //                 /__private/connectors/<name>/invoke
    //             — the Fabric public API
    //
    //   deployed  {rayfinApiUrl}connector-invoke/<name>
    //             — the capacity's BaaS workload endpoint, the only route that
    //               crosses BaaS → FuncSet → delegated OBO
    //
    // `--transport deployed` exists to exercise the second, so it must not reuse
    // the first: the `__private` route answers 404 ENDPOINT_NOT_FOUND for a
    // semantic-model connector whose browser route works.
    //
    // `rayfinApiUrl` already ends in a slash; normalized anyway.
    let invokeUrl: string;
    if (forceDeployed) {
      const baasBase = deployment?.rayfinApiUrl?.replace(/\/+$/, '');
      if (!baasBase) {
        failHandled(
          mode,
          'This deployment has no recorded API URL, so the deployed transport has no endpoint to call.',
          'Run `rayfin up` to refresh the deployment record, then retry.'
        );
      }
      // Checked locally rather than sent and refused: the service answers
      // MISSING_PUBLISHABLE_KEY, which reads like a service fault when the real
      // problem is an incomplete local deployment record.
      if (!deployment?.publishableKey) {
        failHandled(
          mode,
          'This deployment has no recorded publishable key, which the deployed route requires.',
          'Run `rayfin up` to refresh the deployment record, then retry.'
        );
      }
      invokeUrl = `${baasBase}/connector-invoke/${encodeURIComponent(connector.name)}`;
    } else {
      invokeUrl = `${itemEndpoint}/__private/connectors/${encodeURIComponent(connector.name)}/invoke`;
    }
    if (verbose) {
      modeLog(mode, `Invoking ${connector.name}.${resolvedOperation}`);
      modeLog(mode, `POST ${invokeUrl}`);
    }

    const response = await fabricFetch(invokeUrl, {
      method: 'POST',
      headers: {
        Authorization: authorizationHeader,
        [MONIKER_HEADER]: deployment.rayfinItemId,
        'Content-Type': 'application/json',
        // Matches what the deployed app sends. A semantic-model success comes
        // back as an Arrow stream, and asking only for JSON would either be
        // refused or answered in a different shape than the browser gets -
        // which would make this a probe of something other than the real path.
        // Only that connector negotiates Arrow: advertising it to a type whose
        // body we would not decode as Arrow invites a shape we cannot read.
        Accept:
          connector.type === 'fabric-semanticmodel'
            ? 'application/vnd.apache.arrow.stream, application/json'
            : 'application/json',
        // The BaaS route identifies the calling app by publishable key and
        // rejects the request outright without it (MISSING_PUBLISHABLE_KEY).
        // Only sent on that route: the Fabric public API neither wants nor
        // reads it.
        ...(forceDeployed && deployment.publishableKey
          ? { 'X-Publishable-Key': deployment.publishableKey }
          : {}),
      },
      body: JSON.stringify({
        operation: resolvedOperation,
        input,
      }),
    }).catch((error: Error) => {
      return failHandled(
        mode,
        `Connector invoke request failed: ${error.message}`,
        'Verify network connectivity and that your deployment is healthy.'
      );
    });
    const contentType = response.headers.get('content-type') ?? '';
    // Three response shapes reach here. JSON is the common one; a
    // `fabric-semanticmodel` success is an Arrow stream, which `.text()` would
    // turn into mojibake; anything else falls back to text.
    //
    // `octet-stream` is accepted alongside `arrow` because the workload does not
    // always label the stream. Scoped to `fabric-semanticmodel`, since
    // `octet-stream` is the generic "unknown bytes" type.
    const isBinary =
      contentType.includes('arrow') ||
      (connector.type === 'fabric-semanticmodel' &&
        contentType.includes('application/octet-stream'));
    // Correlation handle, passed into the decoder so a decoded result carries
    // the service's request id instead of `parseArrowStream`'s empty default.
    const responseRequestId =
      response.headers.get('requestid') ??
      response.headers.get('x-ms-root-activity-id') ??
      '';
    let payload: unknown;
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else if (isBinary) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      try {
        payload = parseArrowStream(bytes, responseRequestId);
      } catch (error) {
        // The bytes arrived but are not decodable Arrow. Report that as a
        // failure rather than printing binary: a truncated or mislabelled
        // stream is a real fault, and the raw body has no diagnostic value.
        failHandled(
          mode,
          `Connector returned an Arrow stream that could not be decoded: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'Re-run with --verbose. If it persists, the response was truncated in transit.',
          responseRequestId || undefined
        );
      }
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      // Prefer the workload envelope's own account of the failure. The
      // first-deploy rejection arrives as HTTP 500 carrying
      // `WorkloadException/Unauthorized` and no invocation id, and
      // `toFailurePayloadMessage` would `JSON.stringify` that at the user - the
      // envelope reader exists to name the failure instead. It is checked here
      // rather than only after the `ok` gate below, because that gate is what
      // this response fails.
      const message =
        failedEnvelopeMessage(payload) ?? toFailurePayloadMessage(payload);
      const statusLabel = formatHttpStatus(response.status);
      // The BaaS route authenticates the *app*, not the developer: it expects
      // the Rayfin session a deployed client obtains from its publishable key,
      // and the CLI holds a Fabric token instead. Say so, because the generic
      // "sign in again" hint sends people to re-run `rayfin login`, which
      // cannot fix it.
      const deployedAuthGap =
        forceDeployed &&
        response.status === 401 &&
        /invalid authentication token/i.test(
          typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')
        );
      failHandled(
        mode,
        `Connector invoke failed (${statusLabel}): ${message}`,
        deployedAuthGap
          ? 'The deployed route needs a Rayfin app session, which the CLI cannot mint yet - ' +
              '`rayfin login` will not change this. Exercise this path from the deployed app ' +
              'for now, and use `--transport auto` for a CLI-direct query.'
          : getHttpErrorRecoveryHint(response.status, ENVELOPE_RECOVERY_HINT),
        // Correlation matters most on the failures, which is exactly where it
        // was being dropped.
        responseRequestId || undefined,
        readConnectorFailure(payload)?.error
      );
    }

    // A 2xx is not success either: `fabric-semanticmodel` reports a DAX failure
    // *inside* a successful envelope (`status: 'Succeeded'` with
    // `output.queryError`, overflow on `output.tables[0].error`), which the
    // envelope check below does not catch. Normalising through the direct
    // path's `toQueryResult()` also makes both transports return the same shape.
    const normalized =
      connector.type === 'fabric-semanticmodel' &&
      payload !== null &&
      typeof payload === 'object'
        ? toQueryResult(payload as FabricSemanticModelTabularResponse)
        : payload;

    const semanticFailure = readConnectorFailure(normalized);
    if (semanticFailure) {
      const { message, recovery } = describeConnectorFailure(
        semanticFailure.error
      );
      // Prefer the embedded id; fall back to the header so a failure is never
      // uncorrelated.
      failHandled(
        mode,
        message,
        recovery,
        semanticFailure.requestId || responseRequestId || undefined,
        semanticFailure.error
      );
    }

    // Connectors that have not adopted the normalised contract still report
    // failure as a workload envelope, so that check stays for them.
    const failure = failedEnvelopeMessage(payload);
    if (failure) {
      failHandled(
        mode,
        `Connector invoke failed: ${failure}`,
        ENVELOPE_RECOVERY_HINT,
        responseRequestId || undefined
      );
    }

    await emitInvokeSuccess({
      mode,
      connector: connector.name,
      operation: resolvedOperation,
      payload: normalized,
      maxInlineBytes,
      projectRoot,
      ...(options.outputFile ? { outputFile: options.outputFile } : {}),
    });
  });
