/**
 * Real-LLM agent driver using GitHub Copilot CLI (no Anthropic API key
 * required). Runs `copilot -p ... --output-format json` per task and
 * augments the structured JSONL stream with per-turn token telemetry
 * harvested from Copilot's debug log file (only place full ↑input +
 * ↓output + cached counts are exposed in JSON mode).
 *
 * Two transport modes:
 *
 * - **CLI mode**: agent runs with `--allow-all-tools` and a system
 *   prompt that points it at
 *   `node packages/tools/cli/scripts/main docs ...`.
 *   Each shell invocation via Copilot's `bash` tool is a "tool
 *   call" in the eval shape. (Restricting tools via `--available-tools`
 *   makes the agent emit tool calls as TEXT instead of executing them,
 *   so we steer via the prompt and rely on `--allow-all-tools`.)
 * - **MCP mode**: agent runs with `--additional-mcp-config` pointing at
 *   `node packages/tools/mcp/scripts/main start`. The MCP server is
 *   spawned by Copilot CLI for the duration of the agent run.
 *
 * Reuses the eval's `ScriptedRunResult` shape so the orchestrator can
 * mix scripted-baseline rows with real-LLM rows in the same RESULTS.md.
 */
import { spawn } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { type DocsToolCall } from './adapter.js';
import { type ScriptedRunResult } from './scripted-agent.js';
import { LIMITS, type Task } from './tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const CLI_SCRIPT = resolve(
  REPO_ROOT,
  'packages',
  'tools',
  'cli',
  'scripts',
  'main'
);
const MCP_SCRIPT = resolve(
  REPO_ROOT,
  'packages',
  'tools',
  'mcp',
  'scripts',
  'main'
);
const RAW_DOCS_ROOTS = [
  {
    label: 'rayfin-guide',
    module: 'guide',
    root: resolve(REPO_ROOT, 'packages', 'guide', 'assets', 'docs'),
  },
  {
    label: 'rayfin-core',
    module: 'ts-sdk',
    root: resolve(
      REPO_ROOT,
      'packages',
      'typescript-sdk',
      'core',
      'assets',
      'docs'
    ),
  },
  {
    label: 'rayfin-data',
    module: 'ts-sdk',
    root: resolve(
      REPO_ROOT,
      'packages',
      'typescript-sdk',
      'data',
      'assets',
      'docs'
    ),
  },
  {
    label: 'rayfin-auth',
    module: 'ts-sdk',
    root: resolve(
      REPO_ROOT,
      'packages',
      'typescript-sdk',
      'auth',
      'assets',
      'docs'
    ),
  },
  {
    label: 'rayfin-client',
    module: 'ts-sdk',
    root: resolve(
      REPO_ROOT,
      'packages',
      'typescript-sdk',
      'client',
      'assets',
      'docs'
    ),
  },
  {
    label: 'rayfin-host',
    module: 'host',
    root: resolve(REPO_ROOT, 'packages', 'host-docs', 'assets', 'docs'),
  },
] as const;

const COPILOT_TIMEOUT_MS = 5 * 60_000; // 5 min hard cap per task

export type CopilotTransport = 'cli' | 'mcp' | 'raw-docs';

interface ParsedRun {
  finalAnswer: string;
  toolRequestCount: number;
  toolRequests: Array<{ name: string; argsSummary: string }>;
  totalOutputTokens: number;
  totalInputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  turns: number;
  apiDurationMs: number;
  sessionDurationMs: number;
  exitCode: number;
  premiumRequests: number;
}

interface CopilotEvent {
  type: string;
  data?: Record<string, unknown> & {
    content?: string;
    toolRequests?: unknown[];
    outputTokens?: number;
    turnId?: string;
  };
  timestamp?: string;
  usage?: {
    premiumRequests?: number;
    totalApiDurationMs?: number;
    sessionDurationMs?: number;
  };
  exitCode?: number;
}

/**
 * Parse `copilot -p ... --output-format json` stdout (a JSONL stream).
 * Emits per-turn structured data: the final answer, tool requests with
 * args, per-message output tokens (lower-bound for total output), and
 * the result event's `premiumRequests` / API duration.
 *
 * Token totals (input + cached + cache_write + per-turn output) come
 * separately via `harvestUsageFromDebugLog` because Copilot's JSONL
 * doesn't surface input tokens at all. See `runCopilot` for how the
 * two are stitched together.
 */
function parseJsonlEvents(stdout: string): ParsedRun {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  let finalAnswer = '';
  const toolRequests: ParsedRun['toolRequests'] = [];
  let totalOutputTokens = 0;
  let turns = 0;
  let apiDurationMs = 0;
  let sessionDurationMs = 0;
  let exitCode = -1;
  let premiumRequests = 0;

  for (const line of lines) {
    let evt: CopilotEvent;
    try {
      evt = JSON.parse(line) as CopilotEvent;
    } catch {
      continue;
    }
    switch (evt.type) {
      case 'assistant.message': {
        const data = evt.data ?? {};
        const content = String(data.content ?? '');
        if (content.trim()) finalAnswer = content;
        const requests = (data.toolRequests as unknown[]) ?? [];
        for (const req of requests) {
          if (req && typeof req === 'object') {
            const r = req as Record<string, unknown>;
            const name = String(r.name ?? r.tool ?? 'unknown');
            const argsSummary = JSON.stringify(
              r.arguments ?? r.parameters ?? {}
            ).slice(0, 200);
            toolRequests.push({ name, argsSummary });
          }
        }
        if (typeof data.outputTokens === 'number') {
          totalOutputTokens += data.outputTokens;
        }
        break;
      }
      case 'assistant.turn_end':
        turns += 1;
        break;
      case 'result': {
        const data = evt.data ?? evt;
        if (typeof evt.exitCode === 'number') exitCode = evt.exitCode;
        const usage = (evt.usage ?? (data as { usage?: unknown }).usage) as
          | {
              premiumRequests?: number;
              totalApiDurationMs?: number;
              sessionDurationMs?: number;
            }
          | undefined;
        if (usage && typeof usage === 'object') {
          if (typeof usage.totalApiDurationMs === 'number')
            apiDurationMs = usage.totalApiDurationMs;
          if (typeof usage.sessionDurationMs === 'number')
            sessionDurationMs = usage.sessionDurationMs;
          if (typeof usage.premiumRequests === 'number')
            premiumRequests = usage.premiumRequests;
        }
        break;
      }
    }
  }

  return {
    finalAnswer,
    toolRequestCount: toolRequests.length,
    toolRequests,
    totalOutputTokens,
    totalInputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turns,
    apiDurationMs,
    sessionDurationMs,
    exitCode,
    premiumRequests,
  };
}

interface UsageMetrics {
  inputTokens: number;
  inputTokensUncached: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/**
 * Harvest per-task token metrics from Copilot's debug log file.
 *
 * Copilot CLI emits an `assistant_usage` telemetry event into its log
 * file every time it calls the underlying model. The event carries a
 * `metrics` block with `input_tokens`, `input_tokens_uncached`,
 * `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
 * `reasoning_tokens`. We sum across events to get per-task totals.
 *
 * This is the ONLY way to get full input token counts in
 * `--output-format json` mode (the JSONL stream itself doesn't expose
 * input tokens, and the `result` event's `usage` block only carries
 * `premiumRequests` / duration).
 */
function harvestUsageFromDebugLog(logDir: string): UsageMetrics {
  const empty: UsageMetrics = {
    inputTokens: 0,
    inputTokensUncached: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };

  let logFile: string | undefined;
  try {
    const files = readdirSync(logDir).filter((f) => f.endsWith('.log'));
    if (files.length === 0) return empty;
    logFile = join(logDir, files[0]);
  } catch {
    return empty;
  }

  let raw: string;
  try {
    raw = readFileSync(logFile, 'utf8');
  } catch {
    return empty;
  }

  // Each `"kind": "assistant_usage"` is followed by a `"metrics": { ... }`
  // block (pretty-printed across multiple lines). Sum the numeric fields
  // across every assistant_usage event in the log.
  const totals: UsageMetrics = { ...empty };
  const assistantUsageRe = /"kind":\s*"assistant_usage"/g;
  let match: RegExpExecArray | null;
  while ((match = assistantUsageRe.exec(raw)) !== null) {
    const window = raw.slice(match.index, match.index + 4000);
    const metricsStart = window.indexOf('"metrics"');
    if (metricsStart === -1) continue;
    const metricsBlock = window.slice(metricsStart, metricsStart + 1500);

    const readField = (field: string): number => {
      const re = new RegExp(`"${field}":\\s*(\\d+)`);
      const m = metricsBlock.match(re);
      return m ? Number.parseInt(m[1], 10) : 0;
    };

    totals.inputTokens += readField('input_tokens');
    totals.inputTokensUncached += readField('input_tokens_uncached');
    totals.outputTokens += readField('output_tokens');
    totals.cacheReadTokens += readField('cache_read_tokens');
    totals.cacheWriteTokens += readField('cache_write_tokens');
    totals.reasoningTokens += readField('reasoning_tokens');
  }

  return totals;
}

function buildCliPrompt(task: Task): string {
  return [
    'You are an agent answering a question about the Rayfin platform.',
    '',
    'You have a single tool available: `bash`. Use it to invoke the Rayfin CLI to query the installed package docs.',
    '',
    'The CLI is at the absolute path below. Always pass `--json --lean` for compact, lean output (raw inner array/object, no envelope). Available subcommands:',
    '',
    `- \`node ${CLI_SCRIPT.replace(/\\/g, '/')} docs list [--module guide|host|ts-sdk] --json --lean\``,
    `- \`node ${CLI_SCRIPT.replace(/\\/g, '/')} docs search "<query>" [--module ...] [--scope docs|symbols|all] [--limit N] --json --lean\``,
    `- \`node ${CLI_SCRIPT.replace(/\\/g, '/')} docs get [--id <id> | --path <path> | --symbol <name>] [--module ...] --json --lean\``,
    '',
    'Use the tools efficiently. Cite the doc id (e.g. `rayfin-guide:getting-started/index.md`) you used.',
    `Stop after at most ${LIMITS.MAX_TOOL_CALLS} tool calls; if you can't find the answer, say so.`,
    '',
    'Question:',
    '',
    task.prompt,
  ].join('\n');
}

function buildMcpPrompt(task: Task): string {
  return [
    'You are an agent answering a question about the Rayfin platform.',
    '',
    'You have three MCP tools available from the `rayfin-docs` server:',
    '',
    "- `list_docs(module?: 'guide' | 'host' | 'ts-sdk')` — list installed package doc entries.",
    "- `search_docs(query, module?, scope?: 'docs' | 'symbols' | 'all', limit?)` — full-text search.",
    '- `get_doc(id?, path?, symbol?, module?, limit?)` — fetch a single entry by id/path or symbol matches.',
    '',
    'Use the tools efficiently. Cite the doc id (e.g. `rayfin-guide:getting-started/index.md`) you used.',
    `Stop after at most ${LIMITS.MAX_TOOL_CALLS} tool calls; if you can't find the answer, say so.`,
    '',
    'Question:',
    '',
    task.prompt,
  ].join('\n');
}

function buildRawDocsPrompt(task: Task): string {
  return [
    'You are an agent answering a question about the Rayfin platform.',
    '',
    'The Rayfin documentation is available as plain markdown files in the package docs roots below. Use your built-in `bash`/`grep`/`read`/`find` tools to navigate them - there are no specialized search APIs for this transport, just files.',
    '',
    'Docs roots:',
    ...RAW_DOCS_ROOTS.map(
      (root) =>
        `- \`${root.label}\` (${root.module}): \`${root.root.replace(/\\/g, '/')}\``
    ),
    '',
    'The roots are organized by package. Guide docs live under `rayfin-guide`, TypeScript SDK docs live under `rayfin-*` SDK package roots, and .NET host reference docs live under `rayfin-host`.',
    '',
    'Suggested patterns:',
    '- `rg -l "<term>" <docs-root>` to find files mentioning a term',
    '- `rg -n "<term>" <docs-root>` for a scoped search with line numbers',
    '- Read the file directly when you find a strong hit',
    '',
    'Cite the package label and relative path of the doc you used (e.g. `rayfin-guide/quickstart.md`).',
    `Stop after at most ${LIMITS.MAX_TOOL_CALLS} tool calls; if you can't find the answer, say so.`,
    '',
    'Question:',
    '',
    task.prompt,
  ].join('\n');
}

async function runCopilot(
  prompt: string,
  extraArgs: string[]
): Promise<ParsedRun> {
  // Allocate a per-invocation debug log dir so we can harvest token
  // metrics from the `assistant_usage` telemetry events Copilot writes
  // there. JSON mode hides the user-visible usage summary, so the debug
  // log is the only path to per-turn input + cache_read + cache_write
  // counts. We delete the dir after parsing.
  const logDir = mkdtempSync(join(tmpdir(), 'copilot-eval-'));

  return new Promise((resolveResult, rejectResult) => {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--no-ask-user',
      '--allow-all-tools',
      '--log-level',
      'debug',
      '--log-dir',
      logDir,
      ...extraArgs,
    ];
    const proc = spawn('copilot.exe', args, {
      cwd: REPO_ROOT,
      env: { ...process.env, RAYFIN_TELEMETRY_OPTOUT: '1' },
      windowsHide: true,
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    proc.stdout.on('data', (c: string) => stdoutChunks.push(c));
    proc.stderr.on('data', (c: string) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rejectResult(new Error('copilot CLI timed out'));
    }, COPILOT_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      if ((code ?? -1) !== 0 && stdout.length === 0) {
        rmSync(logDir, { recursive: true, force: true });
        rejectResult(
          new Error(
            `copilot exited ${code} with empty stdout; stderr: ${stderr.slice(-500)}`
          )
        );
        return;
      }
      try {
        const parsed = parseJsonlEvents(stdout);
        parsed.exitCode = code ?? -1;
        // Augment with debug-log usage metrics (the JSONL doesn't have them).
        const usage = harvestUsageFromDebugLog(logDir);
        parsed.totalInputTokens = usage.inputTokens;
        parsed.cachedTokens = usage.cacheReadTokens;
        parsed.cacheWriteTokens = usage.cacheWriteTokens;
        parsed.reasoningTokens = usage.reasoningTokens;
        // The debug log's `output_tokens` total is authoritative; the
        // JSONL's per-message `outputTokens` agrees in practice but we
        // prefer the telemetry source when both are available.
        if (usage.outputTokens > 0) {
          parsed.totalOutputTokens = usage.outputTokens;
        }
        rmSync(logDir, { recursive: true, force: true });
        resolveResult(parsed);
      } catch (err) {
        rmSync(logDir, { recursive: true, force: true });
        rejectResult(
          new Error(
            `Failed to parse copilot output: ${
              err instanceof Error ? err.message : String(err)
            }\nstderr: ${stderr.slice(-500)}`
          )
        );
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      rmSync(logDir, { recursive: true, force: true });
      rejectResult(err);
    });
  });
}

export interface CopilotRunMetadata {
  premiumRequests: number;
  apiDurationMs: number;
  sessionDurationMs: number;
  turns: number;
  toolRequests: Array<{ name: string; argsSummary: string }>;
  /**
   * Total tokens the model read (system prompt + tool defs + accumulated
   * conversation + tool results). Sum of `input_tokens` across all
   * `assistant_usage` telemetry events in Copilot's debug log.
   */
  inputTokens: number;
  /** Total tokens the model emitted across all assistant turns. */
  outputTokens: number;
  /** Of the input tokens, how many were served from prompt-cache. */
  cachedTokens: number;
  /** Tokens written to the prompt-cache during this session. */
  cacheWriteTokens: number;
  /** Tokens spent on hidden chain-of-thought (Anthropic reasoning_tokens). */
  reasoningTokens: number;
}

/**
 * Convenience: run a task with the Copilot agent and surface the
 * Copilot-specific metadata (premium requests, API duration, etc.) that
 * doesn't fit the shared ScriptedRunResult shape.
 */
export async function runCopilotTaskFull(
  task: Task,
  transport: CopilotTransport
): Promise<{
  result: ScriptedRunResult;
  copilot: CopilotRunMetadata;
}> {
  const start = process.hrtime.bigint();
  let prompt: string;
  let extraArgs: string[] = [];
  if (transport === 'cli') {
    prompt = buildCliPrompt(task);
  } else if (transport === 'mcp') {
    prompt = buildMcpPrompt(task);
    const mcpConfig = {
      mcpServers: {
        'rayfin-docs': {
          command: process.execPath,
          args: [MCP_SCRIPT, 'start'],
        },
      },
    };
    extraArgs = ['--additional-mcp-config', JSON.stringify(mcpConfig)];
  } else {
    // raw-docs: agent uses Copilot's built-in bash/grep/read tools
    // against the bundled markdown directory directly. No CLI or MCP
    // surface to set up.
    prompt = buildRawDocsPrompt(task);
  }
  const parsed = await runCopilot(prompt, extraArgs);
  const totalDurationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  const toolCalls: DocsToolCall[] = parsed.toolRequests.map((req) => ({
    name: req.name as DocsToolCall['name'],
    arguments: { _argsSummary: req.argsSummary },
  }));
  return {
    result: {
      taskId: task.id,
      transport,
      toolCalls,
      toolResults: [],
      finalAnswer: parsed.finalAnswer,
      terminated: parsed.exitCode === 0,
      totalDurationMs,
      totalRawBytes: 0,
      totalContentBytes: 0,
      estimatedTokens: {
        input: parsed.totalInputTokens,
        output: parsed.totalOutputTokens,
      },
    },
    copilot: {
      premiumRequests: parsed.premiumRequests,
      apiDurationMs: parsed.apiDurationMs,
      sessionDurationMs: parsed.sessionDurationMs,
      turns: parsed.turns,
      toolRequests: parsed.toolRequests,
      inputTokens: parsed.totalInputTokens,
      outputTokens: parsed.totalOutputTokens,
      cachedTokens: parsed.cachedTokens,
      cacheWriteTokens: parsed.cacheWriteTokens,
      reasoningTokens: parsed.reasoningTokens,
    },
  };
}
