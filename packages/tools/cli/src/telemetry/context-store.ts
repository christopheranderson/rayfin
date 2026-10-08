/**
 * Module-level store for the current telemetry invocation context.
 *
 * The CLI runs one command per process invocation, so a simple module
 * variable is sufficient — AsyncLocalStorage is unnecessary.
 */

import type { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';

let currentContext: InvocationContext | undefined;

export function getCurrentContext(): InvocationContext | undefined {
  return currentContext;
}

export function setCurrentContext(ctx: InvocationContext | undefined): void {
  currentContext = ctx;
}
