import {
  ambientMismatchRecovery,
  inspectDbTokenAudience,
  resolveDbTokenTarget,
  unreadableAudienceMessage,
} from '../auth/db-token.js';
import { ensureAuthenticated } from '../auth/index.js';
import { getPowerBiApiBaseUrl } from '../config/constants.js';
import { hasAmbientToken } from '../utils/ambient-env.js';
import { fabricFetch } from '../utils/http-client.js';

const POWER_BI_BASE_URL = `${getPowerBiApiBaseUrl()}/v1.0/myorg`;

export interface CheckSemanticModelAccessArgs {
  /** Workspace the semantic model lives in. */
  workspaceId: string;
  /** Semantic model (dataset) item id. */
  itemId: string;
}

/**
 * Probe Build permission on a semantic model with a throwaway, schema-only
 * DAX query — the same `executeDaxQueries` call the connector would make at
 * query time. Throws on any non-2xx response; resolves on success.
 */
export async function checkSemanticModelAccess(
  args: CheckSemanticModelAccessArgs
): Promise<void> {
  const target = resolveDbTokenTarget();
  const token = await ensureAuthenticated(target.scopes);

  // A supplied token is returned verbatim, so the scopes above were never
  // consulted. Without this the probe's 401 reads as "no Build permission on
  // the model" — the one conclusion this function exists to report — when the
  // real cause is a token minted for another resource.
  if (hasAmbientToken()) {
    const finding = inspectDbTokenAudience(token.token, target);
    if (finding.status === 'unreadable') {
      const { summary, recovery } = unreadableAudienceMessage(target);
      throw new Error(`${summary} ${recovery}`);
    }
    if (finding.status === 'mismatch') {
      throw new Error(
        `Access token has the wrong audience for the semantic model access check (got ${finding.actual}, expected ${target.audience}). ${ambientMismatchRecovery(target)}`
      );
    }
  }

  const url = `${POWER_BI_BASE_URL}/groups/${args.workspaceId}/datasets/${args.itemId}/executeDaxQueries`;

  const response = await fabricFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.apache.arrow.stream, application/json',
      Authorization: `Bearer ${token.token}`,
    },
    body: JSON.stringify({
      query: 'EVALUATE ROW("x", 1)',
      schemaOnly: true,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Semantic model access check failed with status ${response.status}`
    );
  }
}
