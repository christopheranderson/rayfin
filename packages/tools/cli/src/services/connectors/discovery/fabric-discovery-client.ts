import type { DiscoveryScope } from '@microsoft/rayfin-tools-common/_internal/config';

import { FabricApiClient } from '../../fabric/client.js';
import type { FabricItem } from '../../fabric/rayfin-item.js';
import type { FabricWorkspace } from '../../fabric/workspace.js';

/**
 * Run an async mapper over `items` with a bounded number of in-flight
 * promises. Keeps multi-workspace discovery fan-out from opening hundreds
 * of simultaneous Fabric requests while still overlapping I/O.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Thin Fabric REST wrapper shared by every connector discovery provider.
 *
 * Extends {@link FabricApiClient} to reuse the CLI's existing auth header,
 * request plumbing, and `continuationToken` pagination. Two concerns live
 * here so providers stay declarative:
 *
 *  - Resolving a {@link DiscoveryScope} to a concrete workspace list. The
 *    result is memoized per scope so that N providers sharing one client
 *    trigger the `/workspaces` enumeration at most once.
 *  - Listing items of a given Fabric `type` in a workspace via the
 *    server-side `?type=` filter (never list-all-then-filter-client-side).
 */
export class FabricDiscoveryClient extends FabricApiClient {
  private readonly workspaceCache = new Map<
    string,
    Promise<FabricWorkspace[]>
  >();

  /**
   * Memoizes role lookups by `workspaceId:userOid` so providers sharing one
   * client fetch each workspace's role assignments at most once.
   */
  private readonly roleCache = new Map<
    string,
    Promise<'Admin' | 'Member' | 'Contributor' | 'Viewer' | 'Unknown'>
  >();

  /** Max concurrent per-workspace item requests during a fan-out. */
  private readonly concurrency: number;

  public constructor(accessToken: string, concurrency = 4) {
    super(accessToken);
    this.concurrency = concurrency;
  }

  /**
   * Resolve the scope to the concrete set of workspaces to search.
   *
   * Memoized per scope so multiple providers share one enumeration.
   * `tenantWide` is rejected here rather than silently downgraded — the
   * feature is modeled but unimplemented, and a silent downgrade would be
   * worse than an explicit error.
   */
  public resolveWorkspaces(scope: DiscoveryScope): Promise<FabricWorkspace[]> {
    const key = JSON.stringify({
      workspaceId: scope.workspaceId ?? null,
      workspaceIds: scope.workspaceIds ?? null,
      allWorkspaces: !!scope.allWorkspaces,
      tenantWide: !!scope.tenantWide,
    });
    let pending = this.workspaceCache.get(key);
    if (!pending) {
      pending = this.resolveWorkspacesUncached(scope);
      this.workspaceCache.set(key, pending);
    }
    return pending;
  }

  private async resolveWorkspacesUncached(
    scope: DiscoveryScope
  ): Promise<FabricWorkspace[]> {
    if (scope.tenantWide) {
      throw new Error(
        'Tenant-wide discovery is not implemented yet. Use --workspace-id or --all-workspaces.'
      );
    }

    if (scope.workspaceId) {
      return [await this.resolveOneWorkspace(scope.workspaceId)];
    }

    if (scope.workspaceIds && scope.workspaceIds.length > 0) {
      return mapWithConcurrency(scope.workspaceIds, this.concurrency, (id) =>
        this.resolveOneWorkspace(id)
      );
    }

    if (scope.allWorkspaces) {
      return this.listAllPages<FabricWorkspace>('/workspaces');
    }

    throw new Error(
      'Discovery scope is empty. Set workspaceId, workspaceIds, or allWorkspaces.'
    );
  }

  /**
   * Resolve a single workspace id to a workspace record. Some identities can
   * list items in a workspace without being able to GET the workspace
   * resource itself; in that case fall back to a stub (id as display name) so
   * item discovery still proceeds.
   */
  private async resolveOneWorkspace(
    workspaceId: string
  ): Promise<FabricWorkspace> {
    try {
      return await this.request<FabricWorkspace>(`/workspaces/${workspaceId}`);
    } catch {
      return { id: workspaceId, displayName: workspaceId, description: '' };
    }
  }

  /**
   * List every item of `itemType` in `workspaceId`, following pagination.
   * Uses the Fabric `?type=` server-side filter so the service does the
   * narrowing rather than pulling the whole item list over the wire.
   */
  public listItemsOfType(
    workspaceId: string,
    itemType: string
  ): Promise<FabricItem[]> {
    return this.listAllPages<FabricItem>(
      `/workspaces/${workspaceId}/items?type=${encodeURIComponent(itemType)}`
    );
  }

  /**
   * List items of every given type across every given workspace, fanned out
   * with bounded concurrency. Each result carries its resolving workspace so
   * providers can attach the workspace name without a second lookup.
   */
  public async listItemsAcrossWorkspaces(
    workspaces: readonly FabricWorkspace[],
    itemTypes: readonly string[]
  ): Promise<Array<{ workspace: FabricWorkspace; item: FabricItem }>> {
    const jobs: Array<{ workspace: FabricWorkspace; itemType: string }> = [];
    for (const workspace of workspaces) {
      for (const itemType of itemTypes) {
        jobs.push({ workspace, itemType });
      }
    }

    // Tolerate per-job failures — one failed (workspace, itemType) shouldn't
    // discard the rest. Only throw if every job failed (nothing to show).
    let firstError: unknown;
    let failureCount = 0;

    const pages = await mapWithConcurrency(
      jobs,
      this.concurrency,
      async ({ workspace, itemType }) => {
        try {
          const items = await this.listItemsOfType(workspace.id, itemType);
          return items.map((item) => ({ workspace, item }));
        } catch (error) {
          failureCount += 1;
          firstError ??= error;
          return [] as Array<{
            workspace: FabricWorkspace;
            item: FabricItem;
          }>;
        }
      }
    );

    if (jobs.length > 0 && failureCount === jobs.length) {
      throw firstError;
    }

    return pages.flat();
  }

  /**
   * Get the current user's role in a workspace by checking role assignments.
   * Memoized per `workspaceId:userOid` across all providers sharing this client.
   */
  public getMyRoleInWorkspace(
    workspaceId: string,
    userOid?: string
  ): Promise<'Admin' | 'Member' | 'Contributor' | 'Viewer' | 'Unknown'> {
    const key = `${workspaceId}:${userOid ?? ''}`;
    let pending = this.roleCache.get(key);
    if (!pending) {
      pending = this.getMyRoleInWorkspaceUncached(workspaceId, userOid);
      this.roleCache.set(key, pending);
    }
    return pending;
  }

  private async getMyRoleInWorkspaceUncached(
    workspaceId: string,
    userOid?: string
  ): Promise<'Admin' | 'Member' | 'Contributor' | 'Viewer' | 'Unknown'> {
    if (!userOid) return 'Unknown';

    try {
      const response = await this.request<{
        value: Array<{ principal: { id: string }; role: string }>;
      }>(`/workspaces/${workspaceId}/roleAssignments`);

      const match = response.value.find(
        (ra) => ra.principal?.id?.toLowerCase() === userOid.toLowerCase()
      );

      if (!match) return 'Unknown'; // likely group-based assignment

      const role = match.role?.toLowerCase();
      if (role === 'admin') return 'Admin';
      if (role === 'member') return 'Member';
      if (role === 'contributor') return 'Contributor';
      if (role === 'viewer') return 'Viewer';
      return 'Unknown';
    } catch {
      // 403 means user can't list role assignments → infer Viewer
      return 'Viewer';
    }
  }
}

export default FabricDiscoveryClient;
