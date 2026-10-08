/**
 * Fabric / Power BI portal URL parsing.
 *
 * Ported from Lyra's `app-data-cli` package. A developer configuring the CLI
 * path has a browser tab open on the model, not a pair of GUIDs to hand, so
 * accepting the portal URL directly removes the most common source of
 * mis-typed configuration.
 */

import type { FabricSemanticModelTarget } from './directExecute';

/** The kinds of Fabric item a portal URL can address. */
export type FabricItemType = 'semanticModel' | 'lakehouse' | 'warehouse';

/** Result of parsing a Fabric Portal URL. */
export interface ParsedFabricUrl extends FabricSemanticModelTarget {
  /** The kind of item the URL addressed. */
  itemType: FabricItemType;
}

/** URL path segments in the Fabric portal `/groups/` format. */
const FABRIC_SEGMENT_TO_TYPE: Record<string, FabricItemType> = {
  semanticmodels: 'semanticModel',
  modeling: 'semanticModel',
  datasets: 'semanticModel',
  lakehouses: 'lakehouse',
  warehouses: 'warehouse',
};

/** URL path segments in the Power BI OneLake `/details/` format. */
const ONELAKE_SEGMENT_TO_TYPE: Record<string, FabricItemType> = {
  dataset: 'semanticModel',
  lakehouse: 'lakehouse',
  warehouse: 'warehouse',
};

const SUPPORTED_FORMATS = [
  '  - https://app.fabric.microsoft.com/groups/{workspaceId}/semanticmodels/{itemId}',
  '  - https://app.powerbi.com/groups/{workspaceId}/modeling/{itemId}',
  '  - https://app.powerbi.com/onelake/details/{workspaceId}/dataset/{itemId}',
].join('\n');

/**
 * Characters that commonly wrap a URL pasted from a shell or a JSON blob.
 *
 * Tested one character at a time rather than with an anchored `+` quantifier:
 * a pattern like `/["%\s]+$/` backtracks polynomially on long runs of
 * whitespace, which is reachable here because the input is caller-supplied.
 */
const TRAILING_WRAPPER = /["%\s]/;

/** Strip trailing wrapper characters in a single backwards pass. */
function trimTrailingWrappers(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_WRAPPER.test(value.charAt(end - 1))) {
    end--;
  }
  return value.slice(0, end);
}

/**
 * Parse a Fabric Portal or Power BI URL into a workspace id, item id, and item
 * type.
 *
 * Handles query strings, fragments, and sub-pages, so a URL copied mid-session
 * from the address bar works without trimming. The workspace id may be a GUID
 * or the literal `'me'` for My Workspace.
 *
 * @param url - The portal URL to parse.
 * @returns The parsed workspace id, item id, and item type.
 * @throws Error when the URL is malformed or matches no known shape. This
 *   throws rather than returning `undefined` because it is called from
 *   configuration code, where a URL that cannot be understood is a setup
 *   mistake the developer needs told about immediately.
 */
export function parseFabricUrl(url: string): ParsedFabricUrl {
  // Strip trailing encoded quotes and whitespace. A URL pasted from a shell or
  // a JSON blob often arrives wrapped.
  const cleanUrl = trimTrailingWrappers(url).replace(/%22$/gi, '');

  let parsed: URL;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }

  const segments = parsed.pathname.split('/').filter(Boolean);

  const oneLake = matchSegments(segments, 'details', ONELAKE_SEGMENT_TO_TYPE);
  if (oneLake) return oneLake;

  const fabric = matchSegments(segments, 'groups', FABRIC_SEGMENT_TO_TYPE);
  if (fabric) return fabric;

  throw new Error(
    `Could not extract workspace and item ids from URL: "${url}"\n` +
      `Supported formats:\n${SUPPORTED_FORMATS}`
  );
}

/**
 * Match `{anchor}/{workspaceId}/{type}/{itemId}` within a path, returning
 * `undefined` when the anchor is absent, the path is too short, or the type
 * segment is not one this shape recognises.
 */
function matchSegments(
  segments: string[],
  anchor: string,
  typeMap: Record<string, FabricItemType>
): ParsedFabricUrl | undefined {
  const index = segments.indexOf(anchor);
  if (index === -1 || index + 3 >= segments.length) {
    return undefined;
  }

  const workspaceId = segments[index + 1];
  const typeSegment = segments[index + 2];
  const itemId = segments[index + 3];

  const itemType = typeMap[typeSegment.toLowerCase()];
  if (!itemType || !workspaceId || !itemId) {
    return undefined;
  }

  return { workspaceId, itemId, itemType };
}

/**
 * Parse a portal URL and assert it addresses a semantic model.
 *
 * A convenience for wiring `fabricSemanticModel({ target })` straight from a
 * URL. Rejecting a lakehouse or warehouse URL here, rather than letting it
 * through to produce a confusing 404 from the DAX endpoint, keeps the mistake
 * attached to its cause.
 *
 * @param url - The portal URL to parse.
 * @returns The semantic model target.
 * @throws Error when the URL is unparseable or addresses another item type.
 */
export function parseSemanticModelUrl(url: string): FabricSemanticModelTarget {
  const { workspaceId, itemId, itemType } = parseFabricUrl(url);
  if (itemType !== 'semanticModel') {
    throw new Error(
      `URL addresses a ${itemType}, not a semantic model: "${url}"`
    );
  }
  return { workspaceId, itemId };
}
