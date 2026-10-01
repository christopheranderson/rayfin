import { AsyncLocalStorage } from 'node:async_hooks';

import type { InvocationContext } from '@azure/functions';

const CONSOLE_METHODS = [
  'log',
  'error',
  'info',
  'debug',
  'warn',
  'trace',
] as const;
type SupportedConsoleMethod = (typeof CONSOLE_METHODS)[number];

type InvocationLoggerContext = InvocationContext & {
  log?: (...logArgs: unknown[]) => void;
  error?: (...logArgs: unknown[]) => void;
  info?: (...logArgs: unknown[]) => void;
  debug?: (...logArgs: unknown[]) => void;
  warn?: (...logArgs: unknown[]) => void;
  trace?: (...logArgs: unknown[]) => void;
};

const USER_DATA_FUNCTIONS_LOG_PREFIX = '[UserDataFunctions]';
const originalConsoleMethods = Object.fromEntries(
  CONSOLE_METHODS.map((method) => [method, console[method].bind(console)])
) as Record<SupportedConsoleMethod, (...args: unknown[]) => void>;
const invocationScope = new AsyncLocalStorage<string>();
const invocationContexts = new Map<string, InvocationLoggerContext>();

function getFallbackOrder(
  method: SupportedConsoleMethod
): SupportedConsoleMethod[] {
  if (method === 'error' || method === 'warn') {
    return [method, 'log', 'info'];
  }

  return [method, 'info', 'log'];
}

function writeOutsideInvocation(
  method: SupportedConsoleMethod,
  args: unknown[]
): void {
  originalConsoleMethods[method](USER_DATA_FUNCTIONS_LOG_PREFIX, ...args);
}

for (const method of CONSOLE_METHODS) {
  console[method] = (...args: unknown[]) => {
    const invocationId = invocationScope.getStore();
    const context = invocationId
      ? invocationContexts.get(invocationId)
      : undefined;

    if (!context) {
      writeOutsideInvocation(method, args);
      return;
    }

    for (const targetMethod of getFallbackOrder(method)) {
      const logger = context[targetMethod];
      if (typeof logger === 'function') {
        logger.apply(context, [USER_DATA_FUNCTIONS_LOG_PREFIX, ...args]);
        return;
      }
    }

    writeOutsideInvocation(method, args);
  };
}

/**
 * Execute a callback within invocation-scoped logging context.
 *
 * While active, console calls are routed to the current function invocation
 * logger so user-function logs are associated with the correct invocation.
 *
 * @param context - Active Azure Functions invocation context.
 * @param callback - Async callback to execute with invocation-bound logging.
 * @returns The callback result.
 *
 * @internal
 */
export async function runWithInvocationLogging<T>(
  context: InvocationContext,
  callback: () => Promise<T>
): Promise<T> {
  const invocationLoggerContext = context as InvocationLoggerContext;
  invocationContexts.set(context.invocationId, invocationLoggerContext);

  try {
    return await invocationScope.run(context.invocationId, callback);
  } finally {
    invocationContexts.delete(context.invocationId);
  }
}
