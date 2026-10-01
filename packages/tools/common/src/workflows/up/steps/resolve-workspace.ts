/**
 * `up` workflow step: resolve the target Fabric workspace from the identifiers
 * collected by Layer 1.
 *
 * A `--workspace-id` (or `--workspace-uri`-derived id) is fetched directly; a
 * `--workspace` display name is resolved against the caller's accessible
 * workspaces using Fabric's case-sensitive-then-case-insensitive matching,
 * surfacing the same user-actionable errors the CLI has always produced.
 *
 * The step is non-interactive and registry-free: identifiers arrive as typed
 * input (resolved upstream), and the workspace comes back as typed output.
 */
import type {
  FabricClient,
  FabricWorkspace,
} from '../../../external/fabric/index.js';
import type { Step } from '../../types.js';

/** Identifiers for the target workspace, resolved from CLI flags in Layer 1. */
export interface ResolveWorkspaceInput {
  /** Workspace GUID from `--workspace-id` / `--workspace-uri`. Takes precedence. */
  workspaceId?: string;
  /** Workspace display name from `--workspace`, resolved via the Fabric API. */
  workspaceName?: string;
}

/** Capabilities {@link resolveWorkspace} composes. */
export interface ResolveWorkspaceDeps {
  fabric: FabricClient;
}

/**
 * Resolve {@link ResolveWorkspaceInput} to a concrete {@link FabricWorkspace}.
 *
 * Failures are thrown as `Error` at the step level. The workflow entrypoint
 * (`runUpWorkflow`, 2.2b/2.3) is responsible for translating these into
 * `Result.failed` to honor the workflow "never throw for expected failure"
 * contract.
 *
 * @throws When neither identifier is supplied, when a display name matches
 *   zero or more than one workspace, or when the Fabric API call fails.
 */
export const resolveWorkspace: Step<
  ResolveWorkspaceInput,
  FabricWorkspace,
  ResolveWorkspaceDeps
> = async (input, { fabric }) => {
  if (input.workspaceId) {
    return fabric.getWorkspace(input.workspaceId);
  }

  const rawName = input.workspaceName;
  if (rawName !== undefined) {
    const name = rawName.trim();
    if (!name) {
      throw new Error('--workspace value is empty.');
    }
    return resolveByDisplayName(name, fabric);
  }

  throw new Error(
    'resolve-workspace requires a workspace id or name. Provide --workspace or --workspace-id.'
  );
};

/**
 * Match a workspace display name against the accessible workspaces.
 *
 * Mirrors the CLI's established precedence: a case-sensitive exact match wins;
 * otherwise a single case-insensitive match; ambiguity and no-match raise
 * user-actionable errors pointing at `--workspace-id`.
 */
async function resolveByDisplayName(
  name: string,
  fabric: FabricClient
): Promise<FabricWorkspace> {
  const workspaces = await fabric.listWorkspaces();

  const exact = workspaces.filter((ws) => ws.displayName === name);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new Error(
      `Multiple workspaces match "${name}" exactly. Pass --workspace-id <guid> to disambiguate. Matching IDs:\n${exact
        .map((ws) => `  - ${ws.id}`)
        .join('\n')}`
    );
  }

  const lowered = name.toLowerCase();
  const ci = workspaces.filter(
    (ws) => ws.displayName.toLowerCase() === lowered
  );
  if (ci.length === 1) {
    return ci[0];
  }
  if (ci.length > 1) {
    throw new Error(
      `Multiple workspaces match "${name}" (case-insensitive). Pass --workspace-id <guid> to disambiguate. Candidates:\n${ci
        .map((ws) => `  - "${ws.displayName}" (${ws.id})`)
        .join('\n')}`
    );
  }

  throw new Error(
    `Workspace "${name}" not found. Please retry with a valid workspace name.`
  );
}
