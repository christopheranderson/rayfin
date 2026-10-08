/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FabricApiClient } from './client';

export interface FabricWorkspace {
  id: string;
  displayName: string;
  description: string;
  capacityId?: string;
  state?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Client for Microsoft Fabric workspace operations.
 */
export class WorkspaceClient extends FabricApiClient {
  /**
   * Lists all workspaces the authenticated user has access to.
   *
   * Follows Fabric API pagination (`continuationToken`) so callers receive
   * the full set of workspaces, not just the first page (~100 items).
   * See https://learn.microsoft.com/en-us/rest/api/fabric/articles/pagination
   */
  public async listWorkspaces(): Promise<FabricWorkspace[]> {
    type WorkspacePage = {
      value: FabricWorkspace[];
      continuationToken?: string | null;
      continuationUri?: string | null;
    };
    const all: FabricWorkspace[] = [];
    let path: string | undefined = '/workspaces';
    while (path) {
      const page: WorkspacePage = await this.request<WorkspacePage>(path);
      all.push(...page.value);
      path = this.getContinuationPath(page);
    }
    return all;
  }

  private getContinuationPath(page: {
    continuationToken?: string | null;
    continuationUri?: string | null;
  }): string | undefined {
    if (page.continuationUri) {
      const continuationUrl = new URL(page.continuationUri, this.apiBaseUrl);
      const apiBaseUrl = new URL(this.apiBaseUrl);
      const apiBasePath = apiBaseUrl.pathname.replace(/\/$/, '');

      // Only trust `continuationUri` when it targets the same origin and
      // base path as the configured `apiBaseUrl`. When `apiBaseUrl` points
      // at a proxy whose path prefix differs from what Fabric returns,
      // honoring the URI verbatim could drop or duplicate the prefix; fall
      // back to the continuation token in that case.
      const sameOrigin = continuationUrl.origin === apiBaseUrl.origin;
      const sameBasePath =
        apiBasePath === '' ||
        continuationUrl.pathname === apiBasePath ||
        continuationUrl.pathname.startsWith(`${apiBasePath}/`);

      if (sameOrigin && sameBasePath) {
        const continuationPath = apiBasePath
          ? continuationUrl.pathname.slice(apiBasePath.length)
          : continuationUrl.pathname;
        return `${continuationPath}${continuationUrl.search}`;
      }

      if (!page.continuationToken) {
        // Backup: extract the continuation token from the URI's query
        // string and rebuild the request relative to the configured base.
        // `searchParams.get` returns the decoded value, so re-encode it.
        const tokenFromUri =
          continuationUrl.searchParams.get('continuationToken');
        if (tokenFromUri) {
          return `/workspaces?continuationToken=${encodeURIComponent(
            tokenFromUri
          )}`;
        }
      }
    }

    return page.continuationToken
      ? `/workspaces?continuationToken=${page.continuationToken}`
      : undefined;
  }

  /**
   * Gets details of a specific workspace.
   */
  public async getWorkspace(workspaceId: string): Promise<FabricWorkspace> {
    return this.request<FabricWorkspace>(`/workspaces/${workspaceId}`);
  }
}
