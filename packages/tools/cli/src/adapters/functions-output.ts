import { win32 } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { CommandRunner } from '@microsoft/rayfin-tools-common/_internal/adapters';

import { redactTerminalText } from '../diagnostics/sanitize.js';

const CONFIGURATION_HEADER =
  /^(?:Host configuration file read:|ScriptJobHostOptions|LoggerFilterOptions|HttpWorkerOptions|FunctionResultAggregatorOptions|ConcurrencyOptions|SingletonOptions|TimerTriggerPlatformOptions|ScaleOptions|HttpOptions|HttpBodyControlOptions|HostHealthMonitorOptions|WorkerConfigurationResolverOptions|LanguageWorkerOptions|ResponseCompressionOptions|ScriptHostRecycleOptions)$/;
const HOST_DETAIL = [
  /^(?:Building host: version spec:|Reading host configuration file |Starting host metrics provider\.|Initializing Warmup Extension\.|Initializing Host\. OperationId:|Host initialization: ConsecutiveErrors=0,)/,
  /^(?:Starting JobHost$|Starting Host \(HostId=|Loading functions metadata$|Worker indexing is enabled$|Fetching metadata for workerRuntime:|Reading functions metadata \((?:Worker|Custom)\)|\d+ functions (?:found|loaded)\b|Generating \d+ job function\(s\))/,
  /^(?:Worker process started and initialized\.|Worker [\da-f-]+ (?:connecting on|received \w+Request)|Loading entry point file |Loaded entry point file |Setting Node\.js programming model to )/,
  /^(?:Found the following functions:$|Host\.Functions\.[\w.-]+$|Initializing function HTTP routes$|Mapped function route '|Host initialized \(\d+ms\)$|Host started \(\d+ms\)$|Job host started$|Host lock lease acquired by instance ID ')/,
  /^(?:Extension Bundle not loaded\.|Script Startup resetting load context |Loading extension bundle from |Found a matching extension bundle at |Looking for extension bundle )/,
  /^(?:Azure Functions Core Tools$|Core Tools Version:|Function Runtime Version:|For detailed output, run func with --verbose flag\.$|For help, see: https:\/\/nodejs.org\/en\/docs\/inspector)/,
  /^Executing StatusCodeResult, setting HTTP status code [123]\d{2}$/,
  /^(?:Applying platform release channel configuration \w+\. Bundle version \S+ will be used$|Fetching information on versions of extension bundle |Skipping bundle download since it already exists at path |Loading startup extension '[^']+'$|Loaded extension '[^']+' \([\d.]+\)$|Azure Functions Fabric Extension Version: )/,
  /^(?:(?:Watched directory|File|Directory) change of type '\w+' detected for '|Host configuration has changed\. Signaling restart$|Restarting host\.$|Stopping JobHost$|Job host stopped$|Shutting down language worker channels for runtime:\S+$)/,
  /^(?:\[[\w.-]+\] )?LanguageWorkerConsoleLogWorker [\da-f-]+ exited with code 0$/,
  /^Skipping '[^']+' from local settings as it's already defined in current environment variables\.$/,
  /^[\w.:-]+ already exists with value '([^']*)', overriding to '\1'\.$/,
];
const HOST_RESTARTED = /^Host restarted\.$/;
// Core Tools writes log records from several threads without line
// buffering, so a record can start mid-line after another record's text.
const EMBEDDED_RECORD =
  /(?!^)(?=\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\] )/;
const MAX_LINE_BYTES = 16 * 1024;
const ENDPOINT = /^[\w.-]+:\s*(?:\[[A-Z,\s]+\]\s*)?https?:\/\/\S+$/;

interface FunctionsOutputSession {
  requests: Map<string, string>;
  debuggerAddress?: string;
}

export function createFunctionsOutputRunner(
  runner: CommandRunner,
  renderOutput: boolean
): CommandRunner {
  return {
    async run(command, args, options) {
      if (
        win32
          .basename(command)
          .replace(/\.(cmd|exe|bat)$/i, '')
          .toLowerCase() !== 'func'
      ) {
        return runner.run(command, args, options);
      }
      const session: FunctionsOutputSession = { requests: new Map() };
      const stdout = createFunctionsOutput(
        renderOutput ? options?.onStdout : undefined,
        session
      );
      const stderr = createFunctionsOutput(
        renderOutput ? options?.onStderr : undefined,
        session
      );
      try {
        return await runner.run(command, args, {
          ...options,
          inheritStdio: false,
          inheritStdin: options?.inheritStdin ?? options?.inheritStdio ?? false,
          captureOutput: false,
          onStdout: stdout.write,
          onStderr: stderr.write,
        });
      } finally {
        stdout.end();
        stderr.end();
      }
    },
  };
}

interface HttpRequestDetail {
  requestId?: unknown;
  method?: unknown;
  uri?: unknown;
  status?: unknown;
  duration?: unknown;
}

function httpRoute(detail: HttpRequestDetail): string | undefined {
  if (
    typeof detail.method !== 'string' ||
    !/^[a-z]{1,16}$/i.test(detail.method) ||
    typeof detail.uri !== 'string'
  )
    return undefined;
  try {
    const url = new URL(detail.uri, 'http://localhost');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname.length > 2_048
    )
      return undefined;
    return `${detail.method.toUpperCase()} ${url.pathname}`;
  } catch {
    return undefined;
  }
}

function createFunctionsOutput(
  emit: ((text: string) => void) | undefined,
  session: FunctionsOutputSession
) {
  const { requests } = session;
  let pending = '';
  let oversized = false;
  let configuration: string | undefined;
  let httpRecord: 'request' | 'response' | undefined;

  // Returns true when the message is recognized host detail that was either
  // hidden or condensed, so an in-progress configuration record can continue.
  const renderHostDetail = (message: string): boolean => {
    if (HOST_RESTARTED.test(message)) {
      emit?.('Functions host restarted.\n');
      return true;
    }
    return HOST_DETAIL.some((pattern) => pattern.test(message));
  };

  const render = (line: string): void => {
    if (!emit) return;
    const text = stripVTControlCharacters(line).replace(/\r$/, '');
    const records = text.split(EMBEDDED_RECORD);
    if (records.length > 1) {
      for (const record of records) render(record);
      return;
    }
    const message = text.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] /, '');
    if (!message.trim()) return;
    const announcement =
      configuration !== undefined && message.includes(':')
        ? message.match(
            /Functions:$|For detailed output, run func with --verbose flag\.$|[\w.-]+:\s*(?:\[[A-Z,\s]+\]\s*)?https?:\/\/\S+$/
          )
        : null;
    if (
      configuration !== undefined &&
      announcement &&
      (announcement.index ?? 0) > 0
    ) {
      render(message.slice(0, announcement.index));
      render(announcement[0]);
      return;
    }
    if (message === 'Functions:' || ENDPOINT.test(message.trim())) {
      const summary =
        message === 'Functions:'
          ? 'Local functions (Ctrl+C to stop):'
          : `  ${message.trim()}`;
      emit(`${redactTerminalText(summary)}\n`);
      return;
    }
    if (message === 'For detailed output, run func with --verbose flag.')
      return;
    if (/^(?:Executing|Executed) HTTP request: \{$/.test(message)) {
      configuration = '{';
      httpRecord = message.startsWith('Executed ') ? 'response' : 'request';
      return;
    }
    if (configuration !== undefined) {
      if (/^\s*(?:[{}[\]]|"(?:[^"\\]|\\.)*"\s*(?::|,?\s*$))/.test(message)) {
        configuration += message;
        try {
          const detail = JSON.parse(configuration) as HttpRequestDetail | null;
          if (detail && httpRecord) {
            const requestId =
              typeof detail.requestId === 'string' &&
              detail.requestId.length <= 128
                ? detail.requestId
                : undefined;
            const route = httpRoute(detail);
            if (httpRecord === 'request' && requestId && route) {
              requests.set(requestId, route);
              if (requests.size > 100)
                requests.delete(requests.keys().next().value!);
            } else if (httpRecord === 'response') {
              const requestRoute =
                route ?? (requestId ? requests.get(requestId) : undefined);
              if (requestId) requests.delete(requestId);
              if (/^[45]\d{2}$/.test(String(detail.status))) {
                const duration = /^\d+$/.test(String(detail.duration))
                  ? ` (${detail.duration}ms)`
                  : '';
                emit(
                  `${redactTerminalText(`Functions HTTP ${detail.status}${requestRoute ? ` ${requestRoute}` : ''}${duration}`)}\n`
                );
              }
            }
          }
          configuration = undefined;
          httpRecord = undefined;
        } catch {
          if (Buffer.byteLength(configuration ?? '') > MAX_LINE_BYTES)
            configuration = undefined;
        }
        return;
      }
      if (renderHostDetail(message)) return;
      configuration = undefined;
      httpRecord = undefined;
    }
    if (CONFIGURATION_HEADER.test(message)) {
      configuration = '';
      httpRecord = undefined;
      return;
    }
    if (renderHostDetail(message)) return;
    let output = text;
    if (message.startsWith('Debugger listening on ws://')) {
      try {
        const address = new URL(message.slice('Debugger listening on '.length));
        output = `Debugger: ${address.hostname}:${address.port}`;
        // Each host restart starts a new worker that re-announces the same
        // inspector address.
        if (session.debuggerAddress === output) return;
        session.debuggerAddress = output;
      } catch {
        output = text;
      }
    }
    emit(`${redactTerminalText(output)}\n`);
  };

  const flushLine = (): void => {
    render(oversized ? '[Functions output line truncated]' : pending);
    pending = '';
    oversized = false;
  };

  return {
    write(chunk: string): void {
      if (!emit) return;
      const fragments = chunk.split('\n');
      for (const [index, fragment] of fragments.entries()) {
        if (!oversized) {
          pending += fragment;
          if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
            pending = '';
            oversized = true;
          }
        }
        if (index < fragments.length - 1) flushLine();
      }
    },
    end: flushLine,
  };
}
