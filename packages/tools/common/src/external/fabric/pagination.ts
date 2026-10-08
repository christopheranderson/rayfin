/**
 * Fabric list pagination.
 *
 * Every Fabric collection endpoint pages the same way, so the traversal lives
 * with the transport rather than in each host that assembles a client. Reading
 * a page at a time lets a caller searching for one record stop before paying
 * for the rest of the tenant's data.
 */
import type { FabricHttpClient } from './http-client.js';

/** One page of a Fabric list response. */
export interface FabricPage<T> {
  value: T[];
  continuationToken?: string | null;
  continuationUri?: string | null;
}

/**
 * Last-resort bound on pages read for a single list operation.
 *
 * The repeated-cursor check below catches the realistic service bug directly
 * and immediately. This bound exists only to guarantee termination for what
 * that check cannot see — a cursor that cycles through several pages, or one
 * that streams new tokens forever. The loop has no cancellation signal, so a
 * bounded failure beats a CLI that hangs with no output. It is set far above
 * any legitimate tenant and should never be reached in practice.
 */
export const MAX_LIST_PAGES = 1000;

/** Read a Fabric list endpoint one page at a time. */
export async function* readPages<T>(
  transport: FabricHttpClient,
  baseUrl: string,
  initialPath: string
): AsyncGenerator<T[]> {
  let path: string | undefined = initialPath;
  for (let page = 0; path; page++) {
    if (page >= MAX_LIST_PAGES) {
      throw new Error(
        `Fabric list response did not end after ${MAX_LIST_PAGES} pages`
      );
    }

    const body: FabricPage<T> = await transport.request(path);
    if (!Array.isArray(body.value)) {
      throw new Error('Fabric list response is missing its value array');
    }

    yield body.value;

    // A cursor that points back at the page just read never terminates. Naming
    // that directly beats letting the page bound trip much later and blame a
    // cause it cannot actually observe.
    const next = resolveNextPagePath(body, initialPath, baseUrl);
    if (next === path) {
      throw new Error(
        'Fabric list response repeated its continuation cursor; the page sequence is not advancing'
      );
    }
    path = next;
  }
}

/** Every record from a Fabric list endpoint, following the cursor to the end. */
export async function collectPages<T>(
  transport: FabricHttpClient,
  baseUrl: string,
  initialPath: string
): Promise<T[]> {
  const all: T[] = [];
  for await (const value of readPages<T>(transport, baseUrl, initialPath)) {
    all.push(...value);
  }
  return all;
}

/** First record matching `predicate`, reading only as many pages as needed. */
export async function findInPages<T>(
  transport: FabricHttpClient,
  baseUrl: string,
  initialPath: string,
  predicate: (item: T) => boolean
): Promise<T | undefined> {
  for await (const value of readPages<T>(transport, baseUrl, initialPath)) {
    const match = value.find((item) => predicate(item));
    if (match) return match;
  }
  return undefined;
}

/** Transport-relative path of the next page, or `undefined` when exhausted. */
export function resolveNextPagePath(
  page: Pick<FabricPage<unknown>, 'continuationToken' | 'continuationUri'>,
  initialPath: string,
  baseUrl: string
): string | undefined {
  if (page.continuationUri) {
    const continuationUrl = new URL(page.continuationUri, baseUrl);
    const configuredBase = new URL(baseUrl);
    const configuredPath = configuredBase.pathname.replace(/\/$/, '');
    const configuredPathPrefix = `${configuredPath}/`;
    const matchesConfiguredBase =
      continuationUrl.origin === configuredBase.origin &&
      (configuredPath === '' ||
        continuationUrl.pathname === configuredPath ||
        continuationUrl.pathname.startsWith(configuredPathPrefix));

    if (!matchesConfiguredBase) {
      if (page.continuationToken) {
        return appendContinuationToken(initialPath, page.continuationToken);
      }
      throw new Error(
        'Fabric continuation URI does not match the configured API endpoint'
      );
    }

    const relativePath = configuredPath
      ? continuationUrl.pathname.slice(configuredPath.length)
      : continuationUrl.pathname;
    return `${relativePath}${continuationUrl.search}`;
  }

  return page.continuationToken
    ? appendContinuationToken(initialPath, page.continuationToken)
    : undefined;
}

/**
 * Append an opaque continuation token as a query parameter.
 *
 * The token is normalized to one level of percent-encoding: Fabric may return
 * either raw base64 characters or an already encoded cursor.
 */
export function appendContinuationToken(path: string, token: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}continuationToken=${normalizeContinuationToken(token)}`;
}

function normalizeContinuationToken(token: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(token));
  } catch {
    return encodeURIComponent(token);
  }
}

/**
 * Resolve a Fabric-supplied operation location to a transport-relative path.
 *
 * The location is never followed as an absolute URL: the transport attaches a
 * bearer token to whatever it is given. When Fabric returns its canonical
 * origin behind a configured proxy, the trusted operation ID rebuilds the
 * status path under that configured endpoint.
 */
export function resolveOperationPath(
  operationLocation: string,
  baseUrl: string,
  operationId?: string
): string {
  if (operationLocation.startsWith('/')) {
    const configuredPath = new URL(baseUrl).pathname.replace(/\/$/, '');
    if (
      configuredPath &&
      (operationLocation === configuredPath ||
        operationLocation.startsWith(`${configuredPath}/`))
    ) {
      return operationLocation.slice(configuredPath.length) || '/';
    }
    return operationLocation;
  }

  const operationUrl = new URL(operationLocation);
  const configuredBase = new URL(baseUrl);
  const configuredPath = configuredBase.pathname.replace(/\/$/, '');

  if (operationUrl.origin !== configuredBase.origin) {
    if (operationId) {
      return `/operations/${encodeURIComponent(operationId)}`;
    }
    throw new Error(
      'Fabric operation location does not match the configured API endpoint'
    );
  }

  const matchesConfiguredPath =
    configuredPath &&
    (operationUrl.pathname === configuredPath ||
      operationUrl.pathname.startsWith(`${configuredPath}/`));
  const matchesOperationsPath =
    operationUrl.pathname === '/operations' ||
    operationUrl.pathname.startsWith('/operations/');
  if (!matchesConfiguredPath && !matchesOperationsPath) {
    if (operationId) {
      return `/operations/${encodeURIComponent(operationId)}`;
    }
    throw new Error(
      'Fabric operation location does not match the configured API endpoint'
    );
  }
  const relativePath = matchesConfiguredPath
    ? operationUrl.pathname.slice(configuredPath.length) || '/'
    : operationUrl.pathname;

  return `${relativePath}${operationUrl.search}`;
}
