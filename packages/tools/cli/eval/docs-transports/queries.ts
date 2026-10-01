/**
 * Representative queries exercised by the docs-transport eval harness.
 *
 * Each entry is paired so both transports are asked the same question:
 * - `cliArgs` is the argv tail for `rayfin docs <op> ...`.
 * - `mcp.tool` and `mcp.args` describe the equivalent `tools/call`.
 * - `extractCli` and `extractMcp` strip the transport envelopes so the inner
 *   content can be deep-equal compared.
 *
 * Queries are tagged with a `suite` because the CLI and MCP server both
 * default to loading the builder module set (`guide` + `ts-sdk`) and only
 * load `host` when explicitly opted in. The default suite runs against an
 * MCP server started with no flags. The host suite runs against a separate
 * MCP server started with `--host-docs`. The CLI handles both via its
 * `--module host` flag, which constructs a host-only DocsService for that
 * one invocation.
 */

export type DocsOperation = 'list' | 'search' | 'get';
export type DocsEvalSuite = 'default' | 'host';

export interface DocsQuery {
  /** Stable id used in the results table. */
  id: string;
  /** Human description used in the markdown output. */
  description: string;
  /** Which MCP-server flavour this query targets. */
  suite: DocsEvalSuite;
  op: DocsOperation;
  /** CLI argv tail after `rayfin docs <op>`. */
  cliArgs: string[];
  mcp: { tool: string; args: Record<string, unknown> };
  /** Strips the CLI JSON envelope down to the inner content for parity check. */
  extractCli: (parsed: unknown) => unknown;
  /** Strips/parses the MCP tool result down to the inner content. */
  extractMcp: (parsed: unknown) => unknown;
  /** True if this query is expected to fail (errors path). */
  expectError?: boolean;
}

type AnyRecord = Record<string, unknown>;

function asObject(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

const extractCliItems = (parsed: unknown): unknown =>
  asObject(parsed)?.['items'];
const extractCliResults = (parsed: unknown): unknown =>
  asObject(parsed)?.['results'];
const extractCliEntry = (parsed: unknown): unknown =>
  asObject(parsed)?.['entry'];
const extractCliSections = (parsed: unknown): unknown =>
  asObject(parsed)?.['sections'];
const passthrough = (parsed: unknown): unknown => parsed;

export const QUERIES: DocsQuery[] = [
  {
    id: 'list-default',
    description: 'list every default-loaded entry (guide + ts-sdk)',
    suite: 'default',
    op: 'list',
    cliArgs: ['--json'],
    mcp: { tool: 'list_docs', args: {} },
    extractCli: extractCliItems,
    extractMcp: passthrough,
  },
  {
    id: 'list-guide',
    description: 'list `guide` module entries',
    suite: 'default',
    op: 'list',
    cliArgs: ['--module', 'guide', '--json'],
    mcp: { tool: 'list_docs', args: { module: 'guide' } },
    extractCli: extractCliItems,
    extractMcp: passthrough,
  },
  {
    id: 'list-ts-sdk',
    description: 'list `ts-sdk` module entries',
    suite: 'default',
    op: 'list',
    cliArgs: ['--module', 'ts-sdk', '--json'],
    mcp: { tool: 'list_docs', args: { module: 'ts-sdk' } },
    extractCli: extractCliItems,
    extractMcp: passthrough,
  },
  {
    id: 'search-magic-link',
    description: 'search "magic link" with default scope',
    suite: 'default',
    op: 'search',
    cliArgs: ['magic link', '--limit', '5', '--json'],
    mcp: { tool: 'search_docs', args: { query: 'magic link', limit: 5 } },
    extractCli: extractCliResults,
    extractMcp: passthrough,
  },
  {
    id: 'search-rayfinclient-symbols',
    description: 'search "RayfinClient" with scope=symbols',
    suite: 'default',
    op: 'search',
    cliArgs: ['RayfinClient', '--scope', 'symbols', '--limit', '10', '--json'],
    mcp: {
      tool: 'search_docs',
      args: { query: 'RayfinClient', scope: 'symbols', limit: 10 },
    },
    extractCli: extractCliResults,
    extractMcp: passthrough,
  },
  {
    id: 'search-data-api-builder-all',
    description: 'search "data api builder" with scope=all',
    suite: 'default',
    op: 'search',
    cliArgs: ['data api builder', '--scope', 'all', '--limit', '10', '--json'],
    mcp: {
      tool: 'search_docs',
      args: { query: 'data api builder', scope: 'all', limit: 10 },
    },
    extractCli: extractCliResults,
    extractMcp: passthrough,
  },
  {
    id: 'get-by-id-guide-overview',
    description: 'get the guide getting-started entry by id',
    suite: 'default',
    op: 'get',
    cliArgs: ['--id', 'rayfin-guide:getting-started/index.md', '--json'],
    mcp: {
      tool: 'get_doc',
      args: { id: 'rayfin-guide:getting-started/index.md' },
    },
    extractCli: extractCliEntry,
    extractMcp: passthrough,
  },
  {
    id: 'get-by-symbol-rayfinclient',
    description: 'get sections for symbol "RayfinClient"',
    suite: 'default',
    op: 'get',
    cliArgs: ['--symbol', 'RayfinClient', '--limit', '5', '--json'],
    mcp: { tool: 'get_doc', args: { symbol: 'RayfinClient', limit: 5 } },
    extractCli: extractCliSections,
    extractMcp: passthrough,
  },
  {
    id: 'get-by-symbol-rayfinclient-ts-sdk',
    description: 'get sections for symbol "RayfinClient" filtered to ts-sdk',
    suite: 'default',
    op: 'get',
    cliArgs: [
      '--symbol',
      'RayfinClient',
      '--module',
      'ts-sdk',
      '--limit',
      '5',
      '--json',
    ],
    mcp: {
      tool: 'get_doc',
      args: { symbol: 'RayfinClient', module: 'ts-sdk', limit: 5 },
    },
    extractCli: extractCliSections,
    extractMcp: passthrough,
  },
  // Host suite: opt-in via CLI `--module host` and MCP `--host-docs`.
  {
    id: 'list-host',
    description: 'list `host` module entries (opt-in suite)',
    suite: 'host',
    op: 'list',
    cliArgs: ['--module', 'host', '--json'],
    mcp: { tool: 'list_docs', args: { module: 'host' } },
    extractCli: extractCliItems,
    extractMcp: passthrough,
  },
  {
    id: 'search-host-module',
    description: 'search "auth" filtered to `host` module (opt-in suite)',
    suite: 'host',
    op: 'search',
    cliArgs: ['auth', '--module', 'host', '--limit', '5', '--json'],
    mcp: {
      tool: 'search_docs',
      args: { query: 'auth', module: 'host', limit: 5 },
    },
    extractCli: extractCliResults,
    extractMcp: passthrough,
  },
];

export const ERROR_QUERIES: DocsQuery[] = [
  {
    id: 'error-get-unknown-id',
    description: 'get by an id that does not exist',
    suite: 'default',
    op: 'get',
    cliArgs: ['--id', 'guide:does/not/exist.md', '--json'],
    mcp: { tool: 'get_doc', args: { id: 'guide:does/not/exist.md' } },
    extractCli: passthrough,
    extractMcp: passthrough,
    expectError: true,
  },
  {
    id: 'error-get-unknown-symbol',
    description: 'get by a symbol that does not exist',
    suite: 'default',
    op: 'get',
    cliArgs: ['--symbol', 'NoSuchSymbolPleaseDoNotAddOne', '--json'],
    mcp: {
      tool: 'get_doc',
      args: { symbol: 'NoSuchSymbolPleaseDoNotAddOne' },
    },
    extractCli: passthrough,
    extractMcp: passthrough,
    expectError: true,
  },
];
