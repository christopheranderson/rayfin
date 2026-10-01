/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function getRootActivityId(response: Response): string | undefined {
  const rootActivityId = response.headers.get('x-ms-root-activity-id')?.trim();
  if (rootActivityId) {
    return rootActivityId;
  }

  const requestId =
    response.headers.get('RequestId')?.trim() ??
    response.headers.get('requestid')?.trim();
  if (requestId) {
    return requestId;
  }

  return undefined;
}

export function buildRemoteErrorMessage(
  response: Response,
  context: string,
  details?: string
): string {
  let message = `${context}: ${response.status}`;

  if (response.statusText) {
    message += ` ${response.statusText}`;
  }

  if (details) {
    message += `\n   Details: ${details}`;
  }

  const rootActivityId = getRootActivityId(response);
  if (rootActivityId) {
    message += `\n   RootActivityId: ${rootActivityId}`;
  }

  return message;
}

/**
 * Assert that a fetch response is OK, throwing a structured error if not.
 *
 * On error the response body is read and, when possible, parsed as JSON to
 * extract a `.message` or `.error` field for a better developer experience.
 *
 * On success the already-read body text is returned so callers can consume it
 * without a second `response.text()` call.
 *
 * @param response - The fetch Response to check
 * @param context  - A human-readable prefix for the error message
 * @param transformErrorDetails - Optional boundary-specific rewrite for the
 *                                extracted service message and error code
 * @returns The response body text when the response is OK
 * @throws `Error` with a structured message when `!response.ok`
 */
export async function throwIfNotOk(
  response: Response,
  context: string,
  transformErrorDetails?: (details: string, code?: string) => string
): Promise<string> {
  const text = await response.text();

  if (!response.ok) {
    const { details, code } = extractErrorDetails(text);
    throw new Error(
      buildRemoteErrorMessage(
        response,
        context,
        transformErrorDetails ? transformErrorDetails(details, code) : details
      )
    );
  }

  return text;
}

/**
 * Pull the service's own message out of an error body, or fall back to it whole.
 *
 * Only a string is accepted for `details`. The control plane returns its
 * remediation under `message` at the root for some errors and nested under
 * `error` for others, and an unrelated envelope can put an object there — which
 * a downstream translator would then try to run string matching against.
 */
function extractErrorDetails(text: string): {
  details: string;
  code?: string;
} {
  try {
    const json = JSON.parse(text);
    const candidates = [json?.message, json?.error?.message, json?.error];
    const detail = candidates.find((value) => typeof value === 'string');
    const codeCandidates = [json?.code, json?.error?.code, json?.errorCode];
    const code = codeCandidates.find((value) => typeof value === 'string');
    return { details: detail ?? text, code };
  } catch {
    return { details: text };
  }
}
