/**
 * Scripted agent — deterministic strategy that mimics the *shape* of LLM
 * tool-use behaviour for each task without requiring an actual LLM. Used
 * to validate the eval pipeline (transports, scorer, metrics aggregation)
 * end-to-end without an API key, and as a baseline that captures the
 * minimum-tool-use floor for each transport.
 *
 * The scripted strategy per task is hand-authored to produce a "good
 * enough" answer for the rubric, so the resulting score reflects how
 * well the rubric and transports work — not how well the agent reasons.
 * A real LLM agent will use more turns, sometimes search wider, and
 * sometimes get stuck — those numbers come from the LLM mode (not yet
 * implemented; requires API access).
 */
import {
  type DocsAdapter,
  type DocsToolCall,
  type DocsToolResult,
} from './adapter.js';
import { LIMITS, type Task, type ValidationContext } from './tasks.js';

export interface ScriptedRunResult {
  taskId: string;
  transport: 'cli' | 'mcp' | 'raw-docs';
  toolCalls: DocsToolCall[];
  toolResults: DocsToolResult[];
  finalAnswer: string;
  terminated: boolean;
  totalDurationMs: number;
  totalRawBytes: number;
  totalContentBytes: number;
  /** Approximate token estimate (1 token ≈ 4 chars heuristic). */
  estimatedTokens: { input: number; output: number };
}

/**
 * Per-task scripted strategy. Returns the sequence of tool calls and a
 * function that synthesises a final answer from the collected results.
 */
interface Strategy {
  steps: (ctx: StrategyContext) => Promise<DocsToolCall[]>;
  synthesize: (ctx: StrategyContext) => string;
}

interface StrategyContext {
  results: DocsToolResult[];
  calls: DocsToolCall[];
}

function answerFromContent(
  results: DocsToolResult[],
  calls: DocsToolCall[]
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const call = calls[i];
    if (r.error) {
      lines.push(`(tool error from ${call.name}: ${r.error})`);
      continue;
    }
    const content = r.content as unknown;
    if (Array.isArray(content) && content.length > 0) {
      // list_docs / search_docs / get-by-symbol returned arrays.
      const sample = content.slice(0, 3) as Array<Record<string, unknown>>;
      for (const item of sample) {
        if (item && typeof item === 'object') {
          const id = item.id ?? item.entryId ?? '';
          const title = item.title ?? '';
          const snippet = (item.snippet ?? item.content ?? '') as string;
          const truncatedSnippet =
            typeof snippet === 'string' && snippet.length > 240
              ? `${snippet.slice(0, 240)}…`
              : snippet;
          lines.push(
            `- [${id}] ${title}${truncatedSnippet ? `: ${truncatedSnippet}` : ''}`
          );
        }
      }
    } else if (content && typeof content === 'object') {
      // get_doc by id/path returned an entry.
      const entry = content as Record<string, unknown>;
      const id = entry.id ?? '';
      const title = entry.title ?? '';
      const text = (entry.content ?? '') as string;
      const truncated = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      lines.push(`Cited: ${id} — ${title}\n${truncated}`);
    }
  }
  return lines;
}

const STRATEGIES: Record<string, Strategy> = {
  'factual-dev-command': {
    async steps(): Promise<DocsToolCall[]> {
      return [
        // Search for the relevant guide docs.
        {
          name: 'search_docs',
          arguments: { query: 'rayfin dev local development', limit: 3 },
        },
      ];
    },
    synthesize(ctx) {
      const lines = answerFromContent(ctx.results, ctx.calls);
      // Hand-author a final answer that combines the top hit's id with the
      // command. This mimics what a real agent would produce.
      const topCitation = lines.find((l) => l.startsWith('- ['));
      return [
        'Run `rayfin dev` from the project root to start local Rayfin development.',
        'This launches the local DAB-backed dev server.',
        topCitation
          ? topCitation.replace(/^- /, 'Cited: ').replace(/:.*$/, '')
          : 'Cited: rayfin-guide:getting-started/index.md',
      ].join('\n');
    },
  },

  'synthesis-magic-link-react': {
    async steps(ctx) {
      // Step 1 — search for the magic link concept
      const initial: DocsToolCall = {
        name: 'search_docs',
        arguments: { query: 'magic link sign in', scope: 'all', limit: 5 },
      };
      const calls: DocsToolCall[] = [initial];
      // Step 2 — once we see the SDK reference in step 1's results, fetch
      // the full doc for the auth/magic-link guide.
      const firstResult = ctx.results[0];
      if (
        firstResult &&
        Array.isArray(firstResult.content) &&
        firstResult.content.length > 0
      ) {
        const top = firstResult.content[0] as Record<string, unknown>;
        const topId = top.id;
        if (typeof topId === 'string') {
          calls.push({
            name: 'get_doc',
            arguments: { id: topId },
          });
        }
      }
      // Step 3 — also fetch the symbol signature for signInWithMagicLink.
      calls.push({
        name: 'get_doc',
        arguments: {
          symbol: 'signInWithMagicLink',
          module: 'ts-sdk',
          limit: 3,
        },
      });
      return calls;
    },
    synthesize(ctx) {
      const lines = answerFromContent(ctx.results, ctx.calls);
      return [
        'Use `signInWithMagicLink({ email, redirectUri })` from `@microsoft/rayfin-auth` to start a magic-link sign-in.',
        'Pass `redirectUri` (sometimes called `redirectUrl` in older docs) on the options object — that is where the user lands after clicking the verification link.',
        'In a React app, call this from a click handler on your sign-in button and let the SDK handle the redirect.',
        '',
        ...lines.slice(0, 4),
      ].join('\n');
    },
  },

  'negative-stripe-payments': {
    async steps(ctx): Promise<DocsToolCall[]> {
      // Strategy: search for the keyword; if no relevant hits, report the gap.
      const calls: DocsToolCall[] = [
        {
          name: 'search_docs',
          arguments: { query: 'Stripe payments billing', limit: 5 },
        },
      ];
      // Try one broader scope before giving up.
      const firstResult = ctx.results[0];
      const empty =
        !firstResult ||
        (Array.isArray(firstResult.content) &&
          firstResult.content.length === 0);
      if (empty) {
        calls.push({
          name: 'search_docs',
          arguments: { query: 'payment integration', scope: 'all', limit: 5 },
        });
      }
      return calls;
    },
    synthesize(ctx) {
      const allResultsEmpty = ctx.results.every(
        (r) =>
          !r.content ||
          (Array.isArray(r.content) && r.content.length === 0) ||
          (typeof r.content === 'object' &&
            'results' in (r.content as Record<string, unknown>) &&
            Array.isArray((r.content as Record<string, unknown>).results) &&
            ((r.content as Record<string, unknown>).results as unknown[])
              .length === 0)
      );
      // Even if there are some hits, "Stripe" isn't covered. Be honest.
      const hits = ctx.results.flatMap((r) =>
        Array.isArray(r.content)
          ? (r.content as Array<Record<string, unknown>>)
          : []
      );
      const stripeRelevant = hits.some((h) => {
        const text = JSON.stringify(h).toLowerCase();
        return text.includes('stripe');
      });
      if (allResultsEmpty || !stripeRelevant) {
        return [
          "Stripe payment integration isn't covered in the Rayfin docs I can search. The docs cover the SDK, auth, data, deployment, and CLI - I don't see a payment-provider chapter.",
          "If Stripe support exists, it would likely be implemented at the .NET host or your application layer; I can't confirm that from the docs.",
          `(Searched ${ctx.calls.length} time(s); no Stripe-related hits.)`,
        ].join('\n');
      }
      // Unlikely path: false-positive hits — explain why they're irrelevant.
      const lines = answerFromContent(ctx.results, ctx.calls);
      return [
        "I found some hits but none of them are about Stripe specifically — the search appears to have matched on adjacent keywords. Stripe payment integration doesn't appear to be covered in the Rayfin docs.",
        ...lines.slice(0, 2),
      ].join('\n');
    },
  },

  'factual-data-permissions-anonymous-read': {
    async steps(): Promise<DocsToolCall[]> {
      return [
        {
          name: 'search_docs',
          arguments: {
            query: 'data permissions anonymous role',
            limit: 3,
          },
        },
      ];
    },
    synthesize(ctx) {
      const lines = answerFromContent(ctx.results, ctx.calls);
      return [
        "Apply the `@role('anonymous', 'read')` decorator at the class level on the entity to grant unauthenticated users read-only access.",
        '',
        '```typescript',
        "import { entity, role, uuid, text } from '@microsoft/rayfin-core';",
        '',
        "@role('anonymous', 'read')",
        '@entity()',
        'export class Article {',
        '  @uuid() id!: string;',
        '  @text() title!: string;',
        '}',
        '```',
        '',
        'Cited: rayfin-core:permissions.md',
        ...lines.slice(0, 2),
      ].join('\n');
    },
  },

  'symbol-rayfinclient-config': {
    async steps(): Promise<DocsToolCall[]> {
      return [
        {
          name: 'get_doc',
          arguments: { symbol: 'RayfinClient', module: 'ts-sdk', limit: 3 },
        },
        {
          name: 'get_doc',
          arguments: {
            id: 'rayfin-client:index.md',
          },
        },
      ];
    },
    synthesize(ctx) {
      const lines = answerFromContent(ctx.results, ctx.calls);
      return [
        '`RayfinClient` is constructed from a `RayfinClientConfig` (which extends `ApiClientConfig`). The documented fields are:',
        '- `baseUrl` — the API endpoint your Rayfin backend is reachable at.',
        '- `publishableKey` — the publishable Fabric key used to identify the project.',
        '- `authStorage` — optional; `true` for localStorage, `false` for none, or a custom `AuthStorage` implementation.',
        '- `getAccessToken` (inherited from `ApiClientConfig`) — optional callback to supply an access token dynamically.',
        '',
        'Cited: rayfin-client:index.md',
        ...lines.slice(0, 2),
      ].join('\n');
    },
  },

  'synthesis-data-permissions-ownership': {
    async steps(ctx): Promise<DocsToolCall[]> {
      const initial: DocsToolCall = {
        name: 'search_docs',
        arguments: {
          query: 'data permissions check claims',
          scope: 'all',
          limit: 5,
        },
      };
      const calls: DocsToolCall[] = [initial];
      const firstResult = ctx.results[0];
      if (
        firstResult &&
        Array.isArray(firstResult.content) &&
        firstResult.content.length > 0
      ) {
        // Pull the first result that's the data-permissions guide.
        const top = (
          firstResult.content as Array<Record<string, unknown>>
        ).find((h) => {
          const id = (h.id ?? '') as string;
          return id.includes('data/permissions');
        });
        const id = top?.id;
        if (typeof id === 'string') {
          calls.push({ name: 'get_doc', arguments: { id } });
        } else {
          // Fallback: get the canonical doc by id.
          calls.push({
            name: 'get_doc',
            arguments: { id: 'rayfin-core:permissions.md' },
          });
        }
      }
      return calls;
    },
    synthesize(ctx) {
      const lines = answerFromContent(ctx.results, ctx.calls);
      return [
        "Apply two `@role` decorators at the class level — one to gate `read`/`update`/`delete` to authenticated users, and use the `check` callback to pin the row to the caller's JWT subject:",
        '',
        '```typescript',
        "@role('authenticated', ['read', 'update', 'delete'], {",
        '  check: (claims, item) => claims.sub.eq(item.user_id),',
        '})',
        '@entity()',
        'export class Todo {',
        '  @uuid() id!: string;',
        '  @text() user_id!: string;',
        '  @text() title!: string;',
        '}',
        '```',
        '',
        'The `check` expression compiles into a Data API Builder policy (`@claims.sub eq @item.user_id`), so the ownership check is enforced at the DAB layer before any rows are returned — not in your application code.',
        '',
        'Cited: rayfin-core:permissions.md',
        ...lines.slice(0, 2),
      ].join('\n');
    },
  },

  'negative-realtime-subscriptions': {
    async steps(ctx): Promise<DocsToolCall[]> {
      const calls: DocsToolCall[] = [
        {
          name: 'search_docs',
          arguments: { query: 'websocket realtime subscription', limit: 5 },
        },
      ];
      const firstResult = ctx.results[0];
      const empty =
        !firstResult ||
        (Array.isArray(firstResult.content) &&
          firstResult.content.length === 0);
      if (empty) {
        calls.push({
          name: 'search_docs',
          arguments: {
            query: 'subscribe live updates',
            scope: 'all',
            limit: 5,
          },
        });
      }
      return calls;
    },
    synthesize(ctx) {
      return [
        "Realtime subscriptions / WebSocket-based change feeds aren't covered in the Rayfin docs I can search. The data layer is request/response over GraphQL through `@microsoft/rayfin-data`; I don't see a `subscribe()` API or a websocket transport documented.",
        "If you need realtime UI updates today you'd have to poll the GraphQL endpoint or build a separate channel outside Rayfin's documented surface — that wouldn't be a Rayfin-specific recommendation though, just a generic workaround.",
        `(Searched ${ctx.calls.length} time(s); no realtime/websocket hits.)`,
      ].join('\n');
    },
  },

  'factual-graphql-mutation': {
    async steps(): Promise<DocsToolCall[]> {
      return [
        {
          name: 'search_docs',
          arguments: {
            query: 'GraphQL mutation rayfin-data client',
            scope: 'all',
            limit: 3,
          },
        },
      ];
    },
    synthesize(ctx) {
      const lines = answerFromContent(ctx.results, ctx.calls);
      return [
        'Use `GraphQLClient.request(graphqlRequest)` from `@microsoft/rayfin-data`. The `GraphQLRequest` shape carries the `query` (or mutation) string plus optional `variables`:',
        '',
        '```typescript',
        "import { GraphQLClient } from '@microsoft/rayfin-data';",
        '',
        'const client = new GraphQLClient({ /* ... */ });',
        'const result = await client.request({',
        "  query: 'mutation CreateTodo($title: String!) { createTodo(item: { title: $title }) { id } }',",
        "  variables: { title: 'Buy milk' },",
        '});',
        '```',
        '',
        'Cited: rayfin-data:index.md',
        ...lines.slice(0, 2),
      ].join('\n');
    },
  },
};

function estimateTokens(text: string): number {
  // 4 chars ≈ 1 token (cl100k_base average).
  return Math.ceil(text.length / 4);
}

export async function runScriptedTask(
  task: Task,
  adapter: DocsAdapter
): Promise<ScriptedRunResult> {
  const strategy = STRATEGIES[task.id];
  if (!strategy) {
    throw new Error(`No scripted strategy for task '${task.id}'`);
  }
  const start = process.hrtime.bigint();
  const calls: DocsToolCall[] = [];
  const results: DocsToolResult[] = [];
  let terminated = true;

  // NOTE: adapter lifecycle (start/shutdown) is owned by the orchestrator,
  // NOT by this function. MCP must be started ONCE per session and reused
  // across tasks - that's how a real agent uses the protocol. CLI is
  // process-per-call so its "start" is a no-op anyway. Folding start +
  // shutdown into per-task wall-clock would over-report MCP latency by
  // ~2s per task (the FastMCP boot + initialize handshake).
  try {
    // Strategies receive context with calls/results-so-far so they can
    // adapt their next step (mimics LLM looking at prior tool result).
    let pending = await strategy.steps({ calls, results });
    while (pending.length > 0) {
      if (calls.length + pending.length > LIMITS.MAX_TOOL_CALLS) {
        terminated = false;
        break;
      }
      for (const next of pending) {
        const r = await adapter.call(next);
        calls.push(next);
        results.push(r);
      }
      // Re-derive next steps based on accumulated results. A real strategy
      // can iterate; the current ones return all-at-once after the first
      // pass except for synthesis tasks that need to peek at result 0.
      const nextSteps = await strategy.steps({ calls, results });
      // Stop if the strategy didn't add new steps beyond what we already ran.
      if (nextSteps.length <= calls.length) {
        pending = [];
      } else {
        pending = nextSteps.slice(calls.length);
      }
    }
  } catch (err) {
    terminated = false;
    results.push({
      content: { error: err instanceof Error ? err.message : String(err) },
      contentBytes: 0,
      rawBytes: 0,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const finalAnswer = strategy.synthesize({ calls, results });
  const totalDurationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  // Approximate token usage:
  //   input = sum of all tool result content + the system+user prompt
  //   output = the final answer + each tool_use block (rough ~30 tokens each)
  const promptText = task.prompt;
  const toolResultsText = results
    .map((r) => JSON.stringify(r.content))
    .join('\n');
  const inputText = promptText + toolResultsText;
  const outputText = finalAnswer + calls.map((c) => JSON.stringify(c)).join('');
  const estimatedTokens = {
    input: estimateTokens(inputText),
    output: estimateTokens(outputText),
  };

  const m = adapter.metrics();
  return {
    taskId: task.id,
    transport: adapter.transport,
    toolCalls: calls,
    toolResults: results,
    finalAnswer,
    terminated,
    totalDurationMs,
    totalRawBytes: m.totalRawBytes,
    totalContentBytes: m.totalContentBytes,
    estimatedTokens,
  };
}

export function buildValidationContext(
  result: ScriptedRunResult
): ValidationContext {
  return {
    answer: result.finalAnswer,
    toolCalls: result.toolCalls,
    terminated: result.terminated,
  };
}
