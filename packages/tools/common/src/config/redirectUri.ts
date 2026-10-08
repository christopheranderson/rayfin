/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RayfinConfig } from './types.js';

/** Strip trailing slash characters without regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end--;
  }
  return value.slice(0, end);
}

/**
 * Add a redirect URI to the services config if not already present.
 * Only accepts http(s) URIs. Returns a new services object (does not mutate).
 */
export function addAllowedRedirectUri(
  services: RayfinConfig['services'],
  uri: string
): RayfinConfig['services'] {
  if (!uri.startsWith('https://') && !uri.startsWith('http://')) {
    throw new Error(
      `Invalid redirect URI scheme: ${uri}. Only http:// and https:// are allowed.`
    );
  }

  // No auth config — nothing to add to. Avoid synthesizing an auth block.
  if (!services.auth) return services;

  const normalized = stripTrailingSlashes(uri.toLowerCase());
  const existing = services.auth.allowedRedirectUris || [];

  const alreadyPresent = existing.some(
    (u: string) => stripTrailingSlashes(u.toLowerCase()) === normalized
  );
  if (alreadyPresent) return services;

  return {
    ...services,
    auth: {
      ...services.auth,
      allowedRedirectUris: [...existing, uri],
    },
  };
}
