/**
 * Orchestrator for the LLM-agent comparison eval. Runs each task against
 * each transport (CLI + MCP) using the scripted-agent strategy AND the
 * real-LLM strategy (GitHub Copilot CLI) when available, scores with the
 * per-task `validate` predicate, aggregates metrics, and writes a
 * `RESULTS.md` snapshot.
 *
 * The scripted-agent mode validates the pipeline end-to-end and provides
 * baseline transport-level signals (raw bytes, content bytes, durations,
 * tool-call counts). When the `copilot` CLI is on PATH, the orchestrator
 * also runs the real-LLM matrix to capture true tokens, turns, and
 * correctness from a Copilot tool-use loop.
 *
 * See `README.md` for additional details.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { hostname, platform, release } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { type AdapterMetrics } from './adapter.js';
import { CliAdapter } from './cli-adapter.js';
import {
  type CopilotRunMetadata,
  runCopilotTaskFull,
} from './copilot-agent.js';
import { McpAdapter } from './mcp-adapter.js';
import {
  buildValidationContext,
  runScriptedTask,
  type ScriptedRunResult,
} from './scripted-agent.js';
import { TASKS, type Task } from './tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const RESULTS_PATH = resolve(HERE, 'RESULTS.md');
/**
 * Number of trials per (task, transport) for the copilot matrix. The
 * scripted matrix is deterministic so always N=1. Copilot is
 * non-deterministic: per-cell variance can be ±50% on individual tasks
 * (a 13-turn agent spiral on T8 took 107s in one run vs 70s in another),
 * so anything below N=3 makes the headline numbers noise-dominated. At
 * N=5 the median + min/max spread is reliable enough to compare
 * transports apples-to-apples.
 *
 * Override via `RAYFIN_EVAL_RUNS=N` env var for regression / quick passes
 * (e.g. `RAYFIN_EVAL_RUNS=1` for a sanity-check after a refactor).
 */
const RUNS_PER_TASK = (() => {
  const envValue = process.env.RAYFIN_EVAL_RUNS;
  if (envValue === undefined || envValue === '') return 5;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    process.stderr.write(
      `[eval] Ignoring invalid RAYFIN_EVAL_RUNS=${envValue}; using default N=5.\n`
    );
    return 5;
  }
  return parsed;
})();

interface SessionMetrics {
  /** Wall-clock for the one-time adapter session start (start() + first init). */
  sessionStartMs: number;
}

interface RunRecord {
  task: Task;
  transport: 'cli' | 'mcp' | 'raw-docs';
  /** "scripted" = deterministic strategy; "copilot" = real LLM via Copilot CLI. */
  agent: 'scripted' | 'copilot';
  scriptedResult: ScriptedRunResult;
  /** Copilot-specific metadata when agent === "copilot". */
  copilot?: CopilotRunMetadata;
  score: number;
  scoreNotes: string[];
  scoreTags: string[];
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '<unknown>';
  }
}

function gitDirty(): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function readPkgVersion(pkgPath: string): string {
  try {
    return (
      (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string })
        .version ?? '<unknown>'
    );
  } catch {
    return '<unknown>';
  }
}

/**
 * Run all tasks against a single adapter instance. The adapter is
 * started once (paying any session-startup cost — ~2s for MCP, ~0 for
 * CLI) and reused across all tasks. This matches how a real agent
 * session works: an MCP server is spawned at session start and reused
 * for every tool call, not respawned per task.
 *
 * The CLI adapter has no per-session state; its `start()` is a no-op
 * and the per-task wall-clock includes the per-call subprocess spawn
 * cost (which is the actual cost a CLI integration pays).
 */
async function runAllTasksOnTransport(
  transport: 'cli' | 'mcp'
): Promise<{ records: RunRecord[]; session: SessionMetrics }> {
  const adapter = transport === 'cli' ? new CliAdapter() : new McpAdapter();
  const records: RunRecord[] = [];

  // Session-start cost: paid ONCE per transport per eval. For MCP this
  // includes the FastMCP boot + the JSON-RPC initialize handshake. For
  // the lazy MCP adapter, the actual cost is paid on the first tool
  // call - we force-pay it here with a tiny warm-up so the first task's
  // wall-clock isn't polluted.
  const sessionStartBegin = process.hrtime.bigint();
  await adapter.start();
  // Force the lazy MCP spawn + initialize to happen up front.
  if (transport === 'mcp') {
    try {
      await adapter.call({ name: 'list_docs', arguments: {} });
    } catch {
      // Ignore warm-up failures; the first real call will surface them.
    }
  }
  const sessionStartMs =
    Number(process.hrtime.bigint() - sessionStartBegin) / 1_000_000;

  // Reset metrics after the warm-up so per-task accounting starts fresh.
  if ('metricsState' in (adapter as object)) {
    (adapter as unknown as { metricsState: AdapterMetrics }).metricsState = {
      totalCalls: 0,
      totalRawBytes: 0,
      totalContentBytes: 0,
      totalDurationMs: 0,
    };
  }

  try {
    for (const task of TASKS) {
      console.error(`[${transport}] ${task.id}`);
      try {
        const scriptedResult = await runScriptedTask(task, adapter);
        const validation = task.validate(
          buildValidationContext(scriptedResult)
        );
        records.push({
          task,
          transport,
          agent: 'scripted',
          scriptedResult,
          score: validation.score,
          scoreNotes: validation.notes,
          scoreTags: validation.tags,
        });
      } catch (err) {
        console.error(
          `  [${transport}] ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        records.push({
          task,
          transport,
          agent: 'scripted',
          scriptedResult: {
            taskId: task.id,
            transport,
            toolCalls: [],
            toolResults: [],
            finalAnswer: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
            terminated: false,
            totalDurationMs: 0,
            totalRawBytes: 0,
            totalContentBytes: 0,
            estimatedTokens: { input: 0, output: 0 },
          },
          score: 0,
          scoreNotes: [
            `harness error: ${err instanceof Error ? err.message : String(err)}`,
          ],
          scoreTags: ['harness-error'],
        });
      }
    }
  } finally {
    await adapter.shutdown();
  }

  return { records, session: { sessionStartMs } };
}

function fmtBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function fmtMs(value: number): string {
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

function fmtSec(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}

function fmtSignedSec(diff: number): string {
  const seconds = diff / 1000;
  const sign = seconds >= 0 ? '+' : '−';
  return `${sign}${Math.abs(seconds).toFixed(1)}s`;
}

function fmtSignedTokens(diff: number): string {
  const sign = diff >= 0 ? '+' : '−';
  const abs = Math.abs(diff);
  if (abs < 1_000) return `${sign}${abs}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
}

function fmtTokens(value: number): string {
  if (value === 0) return '0';
  if (value < 1_000) return value.toString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Median of a numeric array (linear interpolation between middle pair on even N). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Min and max of a numeric array. */
function rangeOf(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Format wall median + spread as `42.6s [38-58]` (or just `42.6s` for N=1). */
function fmtSecSpread(values: number[]): string {
  if (values.length === 0) return '—';
  const med = median(values);
  if (values.length === 1) return fmtSec(med);
  const { min, max } = rangeOf(values);
  return `${fmtSec(med)} [${(min / 1000).toFixed(1)}-${(max / 1000).toFixed(1)}]`;
}

/** Format token median + spread as `45.3k [38k-58k]` (or just `45.3k` for N=1). */
function fmtTokenSpread(values: number[]): string {
  if (values.length === 0) return '—';
  const med = median(values);
  if (values.length === 1) return fmtTokens(med);
  const { min, max } = rangeOf(values);
  return `${fmtTokens(med)} [${fmtTokens(min)}-${fmtTokens(max)}]`;
}

function passLabel(score: number): string {
  if (score >= 0.75) return '✅';
  if (score >= 0.5) return '🟡';
  return '❌';
}

function renderResults(
  records: RunRecord[],
  sessions: { cli: SessionMetrics; mcp: SessionMetrics },
  options: { copilotPresent: boolean }
): string {
  const lines: string[] = [];
  lines.push('<!-- markdownlint-disable-file -->');
  lines.push('');
  lines.push('# `rayfin docs` LLM-agent comparison eval results');
  lines.push('');
  lines.push(
    'Generated by `packages/tools/cli/eval/llm-agent-comparison/eval.ts`. Manual harness; not run in CI; results are a local snapshot.'
  );
  lines.push('');
  lines.push('## Mode');
  lines.push('');
  if (options.copilotPresent) {
    lines.push(
      '**Scripted baseline + real-LLM (GitHub Copilot CLI).** The scripted strategies measure transport mechanics on a deterministic sequence of tool calls; the real-LLM rows are produced by driving `copilot -p ... --output-format json --no-ask-user --allow-all-tools` once per (task, transport). Real-LLM tool call counts, turns, and tokens are non-deterministic — re-running will produce slightly different numbers.'
    );
  } else {
    lines.push(
      "**Scripted-agent baseline only.** Real-LLM mode (which would capture true tokens, turns, and correctness from a Claude/GPT loop) requires the `copilot` CLI on PATH (or an `ANTHROPIC_API_KEY` for an alternate driver). The scripted strategies validate the harness end-to-end and provide the floor for transport-level metrics. Token estimates here are 4-char-per-token approximations against the scripted strategy's tool-call sequence — they are *not* actual LLM token counts."
    );
  }
  lines.push('');

  // Environment block.
  lines.push('## Environment');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Git SHA | \`${gitSha()}\`${gitDirty() ? ' (dirty)' : ''} |`);
  lines.push(`| Node | \`${process.version}\` |`);
  lines.push(`| Platform | \`${platform()}-${release()}\` |`);
  lines.push(`| Hostname | \`${hostname()}\` |`);
  lines.push(
    `| @microsoft/rayfin-cli | \`${readPkgVersion(resolve(REPO_ROOT, 'packages', 'tools', 'cli', 'package.json'))}\` |`
  );
  lines.push(
    `| @microsoft/rayfin-mcp | \`${readPkgVersion(resolve(REPO_ROOT, 'packages', 'tools', 'mcp', 'package.json'))}\` |`
  );
  lines.push(`| Tasks | ${TASKS.length} (one per tier) |`);
  lines.push(
    `| Runs per (task, transport) | scripted=1 (deterministic), copilot=${RUNS_PER_TASK} |`
  );
  lines.push(`| Generated at | ${new Date().toISOString()} |`);
  lines.push('');

  // Summary.
  const passes = records.filter((r) => r.score >= 0.75).length;
  const scriptedCount = records.filter((r) => r.agent === 'scripted').length;
  const copilotCount = records.filter((r) => r.agent === 'copilot').length;
  lines.push('## Summary');
  lines.push('');
  const breakdown = options.copilotPresent
    ? `${TASKS.length} tasks × (1 scripted × 2 transports + ${RUNS_PER_TASK} copilot × 3 transports)`
    : `${TASKS.length} tasks × 2 transports × 1 run`;
  lines.push(`- Total runs: ${records.length} (${breakdown})`);
  lines.push(
    `- Scripted baseline: ${scriptedCount} runs · Real-LLM (Copilot): ${copilotCount} runs`
  );
  lines.push(`- Passed (score ≥ 0.75): **${passes}/${records.length}**`);
  lines.push('');

  // Session-startup costs - paid ONCE per transport per agent session.
  lines.push('## Session-startup cost (paid once per transport per session)');
  lines.push('');
  lines.push('| Transport | Session start ms | Notes |');
  lines.push('| --- | ---: | --- |');
  lines.push(
    `| CLI | ${fmtMs(sessions.cli.sessionStartMs)} | No persistent process; \`start()\` is a no-op. Per-call subprocess spawn cost is included in each task's wall-clock. |`
  );
  lines.push(
    `| MCP | ${fmtMs(sessions.mcp.sessionStartMs)} | One-time \`raymcp start\` boot + JSON-RPC \`initialize\` handshake + warm-up call. Amortized across all subsequent tool calls in the session. |`
  );
  lines.push('');

  // Cumulative per-transport totals + amortized projection.
  // Restrict to scripted records since Copilot's per-task wall is
  // end-to-end LLM time, not transport latency.
  const scriptedRecords = records.filter((r) => r.agent === 'scripted');
  const copilotRecords = records.filter((r) => r.agent === 'copilot');
  const cliRecords = scriptedRecords.filter((r) => r.transport === 'cli');
  const mcpRecords = scriptedRecords.filter((r) => r.transport === 'mcp');
  const sumWall = (rs: RunRecord[]): number =>
    rs.reduce((a, r) => a + r.scriptedResult.totalDurationMs, 0);
  const sumCalls = (rs: RunRecord[]): number =>
    rs.reduce((a, r) => a + r.scriptedResult.toolCalls.length, 0);
  const cliTaskWall = sumWall(cliRecords);
  const mcpTaskWall = sumWall(mcpRecords);
  const cliTotalCalls = sumCalls(cliRecords);
  const mcpTotalCalls = sumCalls(mcpRecords);
  const cliPerCall = cliTotalCalls === 0 ? 0 : cliTaskWall / cliTotalCalls;
  const mcpPerCall = mcpTotalCalls === 0 ? 0 : mcpTaskWall / mcpTotalCalls;
  const cliSession = sessions.cli.sessionStartMs + cliTaskWall;
  const mcpSession = sessions.mcp.sessionStartMs + mcpTaskWall;

  lines.push('## Per-transport session totals');
  lines.push('');
  lines.push(
    '| Transport | Tool calls | Sum task wall (excl. session start) | Per-call wall | Total session wall (incl. start) |'
  );
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  lines.push(
    `| CLI | ${cliTotalCalls} | ${fmtMs(cliTaskWall)} ms | ${fmtMs(cliPerCall)} ms | ${fmtMs(cliSession)} ms |`
  );
  lines.push(
    `| MCP | ${mcpTotalCalls} | ${fmtMs(mcpTaskWall)} ms | ${fmtMs(mcpPerCall)} ms | ${fmtMs(mcpSession)} ms |`
  );
  lines.push('');

  // Crossover projection: at what call count does MCP overtake CLI?
  // CLI session = N × cliPerCall
  // MCP session = mcpStart + N × mcpPerCall
  // Crossover when: N × cliPerCall = mcpStart + N × mcpPerCall
  // => N = mcpStart / (cliPerCall - mcpPerCall)
  if (cliPerCall > mcpPerCall) {
    const crossoverN = Math.ceil(
      sessions.mcp.sessionStartMs / (cliPerCall - mcpPerCall)
    );
    lines.push(
      `**Crossover**: at **N=${crossoverN} tool calls** in a session, MCP's amortized cost equals CLI's. Below that, CLI wins on absolute wall-clock; above it, MCP wins (and the gap grows linearly).`
    );
    lines.push('');
    // Projected session wall for representative N values.
    lines.push('### Amortized session wall by tool-call count');
    lines.push('');
    lines.push(
      '| Tool calls in session | CLI wall (no start) | MCP wall (start + per-call) |'
    );
    lines.push('| ---: | ---: | ---: |');
    for (const n of [1, 3, 5, 10, 25, 50]) {
      const cliN = n * cliPerCall;
      const mcpN = sessions.mcp.sessionStartMs + n * mcpPerCall;
      const winner =
        cliN < mcpN ? '← CLI faster' : mcpN < cliN ? '← MCP faster' : 'tied';
      lines.push(`| ${n} | ${fmtMs(cliN)} ms | ${fmtMs(mcpN)} ms ${winner} |`);
    }
    lines.push('');
  }

  // Per-task per-transport table (scripted only).
  lines.push('## Per-task results — scripted baseline');
  lines.push('');
  lines.push(
    '| Task | Tier | Transport | Score | Tool calls | Task wall ms (excl. session start) | Raw bytes | Content bytes | Est. input tokens | Est. output tokens | Tags |'
  );
  lines.push(
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  );
  for (const r of scriptedRecords) {
    lines.push(
      `| \`${r.task.id}\` | ${r.task.tier} | ${r.transport} | ${passLabel(r.score)} ${r.score.toFixed(2)} | ${r.scriptedResult.toolCalls.length} | ${fmtMs(r.scriptedResult.totalDurationMs)} | ${fmtBytes(r.scriptedResult.totalRawBytes)} | ${fmtBytes(r.scriptedResult.totalContentBytes)} | ${r.scriptedResult.estimatedTokens.input} | ${r.scriptedResult.estimatedTokens.output} | ${r.scoreTags.join(', ') || '—'} |`
    );
  }
  lines.push('');

  // Real-LLM (Copilot) section.
  lines.push('## Per-task results — real LLM (GitHub Copilot CLI)');
  lines.push('');
  if (copilotRecords.length === 0) {
    if (options.copilotPresent) {
      lines.push('_No Copilot runs were captured this session._');
    } else {
      lines.push(
        '_Skipped — `copilot` CLI not found in PATH. Install GitHub Copilot CLI to run real-LLM mode._'
      );
    }
    lines.push('');
  } else {
    lines.push(
      "Driven by `copilot -p ... --output-format json --no-ask-user --allow-all-tools --log-level debug --log-dir <tmp>`. JSONL on stdout gives us per-turn structured data (tool requests, output tokens per turn, turn counts); the debug log gives us per-task input + cache_read + cache_write totals via the `assistant_usage` telemetry events. The agent's tool choices, reasoning, and termination are non-deterministic; rerunning will produce slightly different numbers."
    );
    lines.push('');
    lines.push(
      "> **Tokens are real model-billed counts**, summed across every `assistant_usage` telemetry event Copilot writes to its debug log (`metrics.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`). `Fresh input` = `Input - Cached`, the tokens that actually hit the model uncached. Anthropic's prompt caching charges cached reads at ~10% of the uncached price, so most of the input is effectively free after the first turn."
    );
    lines.push('');
    lines.push(
      "> Premium-request count is omitted from the table - it's a flat `10` per invocation regardless of work done (verified: a 1-turn 7-token answer reports the same value as a 13-turn synthesis task), so it's a session billing unit, not a useful CLI-vs-MCP signal."
    );
    lines.push('');
    lines.push(
      `Each (task, transport) cell is run **N=${RUNS_PER_TASK}** times to soak up Copilot's non-determinism. The per-task table below shows the median across trials with min-max in brackets, e.g. \`42.6s [38-58]\`. Aggregate totals at the bottom sum the per-task medians. Pass/fail is the median score (≥ 0.75); individual trial scores can vary.`
    );
    lines.push('');
    lines.push(
      '| Task | Transport | Pass rate | Median turns | Median tool reqs | Wall | ↑ Input | ↓ Output | Fresh input |'
    );
    lines.push(
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const task of TASKS) {
      for (const transport of ['cli', 'mcp', 'raw-docs'] as const) {
        const cell = copilotRecords.filter(
          (r) => r.task.id === task.id && r.transport === transport
        );
        if (cell.length === 0) continue;
        const passes = cell.filter((r) => r.score >= 0.75).length;
        const passRate = `${passes}/${cell.length}`;
        const turns = cell.map((r) => r.copilot?.turns ?? 0);
        const reqs = cell.map((r) => r.copilot?.toolRequests.length ?? 0);
        const wall = cell.map((r) => r.scriptedResult.totalDurationMs);
        const inTok = cell.map((r) => r.copilot?.inputTokens ?? 0);
        const outTok = cell.map((r) => r.copilot?.outputTokens ?? 0);
        const cached = cell.map((r) => r.copilot?.cachedTokens ?? 0);
        const fresh = inTok.map((v, i) => Math.max(0, v - cached[i]));
        lines.push(
          `| \`${task.id}\` | ${transport} | ${passRate} | ${median(turns).toFixed(0)} | ${median(reqs).toFixed(0)} | ${fmtSecSpread(wall)} | ${fmtTokenSpread(inTok)} | ${fmtTokenSpread(outTok)} | ${fmtTokenSpread(fresh)} |`
        );
      }
    }
    lines.push('');

    // Per-task delta for real-LLM rows. Lead with absolute Δ values
    // (the user-impactful question: "how many more seconds / tokens?")
    // and keep ratios as a secondary signal. Three transports per task;
    // we render three side-by-side metric tables for readability.
    lines.push('### Real-LLM CLI vs MCP vs raw-docs deltas');
    lines.push('');
    lines.push(
      'Each cell is the **median** across the N trials. `Δ vs MCP` is the absolute difference between medians (positive = transport spent more than MCP). `raw-docs` points the agent at the bundled markdown directory and lets it use built-in `bash`/`grep`/`read` with no specialised search API.'
    );
    lines.push('');

    // Helper: collect per-task records keyed by transport, with all
    // trials for each cell.
    type TripleCell = {
      task: Task;
      cli: RunRecord[];
      mcp: RunRecord[];
      raw: RunRecord[];
    };
    const triples: TripleCell[] = TASKS.map((task) => ({
      task,
      cli: copilotRecords.filter(
        (r) => r.task.id === task.id && r.transport === 'cli'
      ),
      mcp: copilotRecords.filter(
        (r) => r.task.id === task.id && r.transport === 'mcp'
      ),
      raw: copilotRecords.filter(
        (r) => r.task.id === task.id && r.transport === 'raw-docs'
      ),
    }));

    const wallsOf = (rs: RunRecord[]): number[] =>
      rs.map((r) => r.scriptedResult.totalDurationMs);
    const freshOf = (rs: RunRecord[]): number[] =>
      rs.map((r) => {
        const inTok = r.copilot?.inputTokens ?? 0;
        const cached = r.copilot?.cachedTokens ?? 0;
        return Math.max(0, inTok - cached);
      });
    const outsOf = (rs: RunRecord[]): number[] =>
      rs.map((r) => r.copilot?.outputTokens ?? 0);

    lines.push('#### Wall time (median)');
    lines.push('');
    lines.push('| Task | CLI | MCP | raw-docs | Δ CLI−MCP | Δ raw−MCP |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const t of triples) {
      if (t.cli.length === 0 || t.mcp.length === 0 || t.raw.length === 0)
        continue;
      const cliMed = median(wallsOf(t.cli));
      const mcpMed = median(wallsOf(t.mcp));
      const rawMed = median(wallsOf(t.raw));
      lines.push(
        `| \`${t.task.id}\` | ${fmtSec(cliMed)} | ${fmtSec(mcpMed)} | ${fmtSec(rawMed)} | ${fmtSignedSec(cliMed - mcpMed)} | ${fmtSignedSec(rawMed - mcpMed)} |`
      );
    }
    lines.push('');

    lines.push('#### Fresh input tokens (median, input − cached)');
    lines.push('');
    lines.push('| Task | CLI | MCP | raw-docs | Δ CLI−MCP | Δ raw−MCP |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const t of triples) {
      if (t.cli.length === 0 || t.mcp.length === 0 || t.raw.length === 0)
        continue;
      const cliMed = median(freshOf(t.cli));
      const mcpMed = median(freshOf(t.mcp));
      const rawMed = median(freshOf(t.raw));
      lines.push(
        `| \`${t.task.id}\` | ${fmtTokens(cliMed)} | ${fmtTokens(mcpMed)} | ${fmtTokens(rawMed)} | ${fmtSignedTokens(cliMed - mcpMed)} | ${fmtSignedTokens(rawMed - mcpMed)} |`
      );
    }
    lines.push('');

    lines.push('#### Output tokens (median)');
    lines.push('');
    lines.push('| Task | CLI | MCP | raw-docs | Δ CLI−MCP | Δ raw−MCP |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const t of triples) {
      if (t.cli.length === 0 || t.mcp.length === 0 || t.raw.length === 0)
        continue;
      const cliMed = median(outsOf(t.cli));
      const mcpMed = median(outsOf(t.mcp));
      const rawMed = median(outsOf(t.raw));
      lines.push(
        `| \`${t.task.id}\` | ${fmtTokens(cliMed)} | ${fmtTokens(mcpMed)} | ${fmtTokens(rawMed)} | ${fmtSignedTokens(cliMed - mcpMed)} | ${fmtSignedTokens(rawMed - mcpMed)} |`
      );
    }
    lines.push('');

    // Aggregate totals: sum each cell's MEDIAN. Doing it this way (vs
    // sum of all trials) gives the "what does a typical full session
    // cost" answer rather than "what does N typical sessions cost".
    const completeTriples = triples.filter(
      (t) => t.cli.length > 0 && t.mcp.length > 0 && t.raw.length > 0
    );
    if (completeTriples.length > 0) {
      const sumMedian = (
        sel: (t: TripleCell) => RunRecord[],
        toValues: (rs: RunRecord[]) => number[]
      ): number =>
        completeTriples.reduce((a, t) => a + median(toValues(sel(t))), 0);

      const cliWallSum = sumMedian((t) => t.cli, wallsOf);
      const mcpWallSum = sumMedian((t) => t.mcp, wallsOf);
      const rawWallSum = sumMedian((t) => t.raw, wallsOf);
      const cliFreshSum = sumMedian((t) => t.cli, freshOf);
      const mcpFreshSum = sumMedian((t) => t.mcp, freshOf);
      const rawFreshSum = sumMedian((t) => t.raw, freshOf);
      const cliOutSum = sumMedian((t) => t.cli, outsOf);
      const mcpOutSum = sumMedian((t) => t.mcp, outsOf);
      const rawOutSum = sumMedian((t) => t.raw, outsOf);

      lines.push('### Real-LLM totals (sum of per-task medians)');
      lines.push('');
      lines.push(
        `Aggregated over ${completeTriples.length} tasks - the user-impactful "what does a typical full session cost" answer. Each per-task contribution is the median wall/tokens across that task's ${RUNS_PER_TASK} trials, then summed across tasks.`
      );
      lines.push('');
      lines.push('| Metric | CLI | MCP | raw-docs | Δ CLI−MCP | Δ raw−MCP |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
      lines.push(
        `| Wall time | ${fmtSec(cliWallSum)} | ${fmtSec(mcpWallSum)} | ${fmtSec(rawWallSum)} | ${fmtSignedSec(cliWallSum - mcpWallSum)} | ${fmtSignedSec(rawWallSum - mcpWallSum)} |`
      );
      lines.push(
        `| Fresh input tokens | ${fmtTokens(cliFreshSum)} | ${fmtTokens(mcpFreshSum)} | ${fmtTokens(rawFreshSum)} | ${fmtSignedTokens(cliFreshSum - mcpFreshSum)} | ${fmtSignedTokens(rawFreshSum - mcpFreshSum)} |`
      );
      lines.push(
        `| Output tokens | ${fmtTokens(cliOutSum)} | ${fmtTokens(mcpOutSum)} | ${fmtTokens(rawOutSum)} | ${fmtSignedTokens(cliOutSum - mcpOutSum)} | ${fmtSignedTokens(rawOutSum - mcpOutSum)} |`
      );
      lines.push('');
    }
  }

  // Per-task transport delta (scripted only).
  lines.push('## Per-task delta — scripted baseline (CLI vs MCP)');
  lines.push('');
  lines.push(
    '| Task | CLI score | MCP score | CLI tool calls | MCP tool calls | CLI raw bytes | MCP raw bytes | CLI/MCP raw ratio | CLI/MCP wall ratio |'
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const task of TASKS) {
    const cli = scriptedRecords.find(
      (r) => r.task.id === task.id && r.transport === 'cli'
    );
    const mcp = scriptedRecords.find(
      (r) => r.task.id === task.id && r.transport === 'mcp'
    );
    if (!cli || !mcp) continue;
    const rawRatio =
      mcp.scriptedResult.totalRawBytes === 0
        ? '—'
        : (
            cli.scriptedResult.totalRawBytes / mcp.scriptedResult.totalRawBytes
          ).toFixed(1) + '×';
    const wallRatio = (
      cli.scriptedResult.totalDurationMs /
      Math.max(1, mcp.scriptedResult.totalDurationMs)
    ).toFixed(1);
    lines.push(
      `| \`${task.id}\` | ${cli.score.toFixed(2)} | ${mcp.score.toFixed(2)} | ${cli.scriptedResult.toolCalls.length} | ${mcp.scriptedResult.toolCalls.length} | ${fmtBytes(cli.scriptedResult.totalRawBytes)} | ${fmtBytes(mcp.scriptedResult.totalRawBytes)} | ${rawRatio} | ${wallRatio}× |`
    );
  }
  lines.push('');

  // Per-task transcripts (truncated).
  lines.push('## Transcripts (truncated)');
  lines.push('');
  for (const r of records) {
    lines.push(`### \`${r.task.id}\` — ${r.transport.toUpperCase()}`);
    lines.push('');
    lines.push('**Prompt**: ' + r.task.prompt);
    lines.push('');
    lines.push('**Tool calls**:');
    lines.push('');
    for (let i = 0; i < r.scriptedResult.toolCalls.length; i += 1) {
      const c = r.scriptedResult.toolCalls[i];
      const result = r.scriptedResult.toolResults[i];
      const argSummary = JSON.stringify(c.arguments);
      let resultSummary: string;
      if (!result) {
        resultSummary = '(result not captured)';
      } else if (result.error) {
        resultSummary = `error=${result.error.slice(0, 120)}`;
      } else {
        resultSummary = `${fmtBytes(result.contentBytes)} content / ${fmtBytes(result.rawBytes)} raw / ${fmtMs(result.durationMs)} ms`;
      }
      lines.push(`${i + 1}. \`${c.name}(${argSummary})\` → ${resultSummary}`);
    }
    lines.push('');
    lines.push('**Final answer**:');
    lines.push('');
    lines.push('```');
    lines.push(
      r.scriptedResult.finalAnswer.slice(0, 800) +
        (r.scriptedResult.finalAnswer.length > 800 ? '…' : '')
    );
    lines.push('```');
    lines.push('');
    lines.push(
      `**Score**: ${r.score.toFixed(2)} ${passLabel(r.score)} — ${r.scoreNotes.join('; ')}`
    );
    if (r.scoreTags.length > 0) {
      lines.push(`**Tags**: ${r.scoreTags.join(', ')}`);
    }
    lines.push('');
  }

  // Notes.
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- The eval runs in *controlled-parity* mode: the agent (scripted or LLM) sees identical tool names, parameters, and a *normalized* result shape across both transports. Raw transport bytes are recorded separately so the realistic-surface delta is still measurable.'
  );
  lines.push(
    '- Token estimates use a 1-token-per-4-character heuristic. Real LLM input/output tokens will differ in absolute value but the *ratio* between transports should be close.'
  );
  lines.push(
    "- The scripted-agent strategies are hand-authored to produce a defensible answer. They are NOT a substitute for an LLM — they don't make wrong tool choices, they don't loop, and they don't hallucinate. The real-LLM (Copilot) rows above capture actual tool-use behaviour from the agent."
  );
  lines.push(
    '- Hard caps: MAX_TURNS=20, MAX_TOOL_CALLS=15, TASK_TIMEOUT_MS=120_000. `MAX_TOOL_CALLS` is enforced (scripted agent stops; copilot prompt instructs the LLM to stop). `MAX_TURNS` and the timeout are advisory caps surfaced in tags via `excess-tool-calls` / `turn-cap-hit`.'
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the real-LLM (Copilot CLI) matrix: every task on every transport.
 * Each invocation spawns a fresh Copilot CLI subprocess. Costs ~10
 * premium requests per (task, transport) row.
 */
async function runCopilotMatrix(): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const task of TASKS) {
    for (const transport of ['cli', 'mcp', 'raw-docs'] as const) {
      for (let trial = 1; trial <= RUNS_PER_TASK; trial += 1) {
        console.error(
          `[copilot/${transport}] ${task.id} (${trial}/${RUNS_PER_TASK})`
        );
        try {
          const { result, copilot } = await runCopilotTaskFull(task, transport);
          const validation = task.validate(buildValidationContext(result));
          records.push({
            task,
            transport,
            agent: 'copilot',
            scriptedResult: result,
            copilot,
            score: validation.score,
            scoreNotes: validation.notes,
            scoreTags: validation.tags,
          });
        } catch (err) {
          console.error(
            `  [copilot/${transport}] ${task.id} (${trial}/${RUNS_PER_TASK}) failed: ${err instanceof Error ? err.message : String(err)}`
          );
          records.push({
            task,
            transport,
            agent: 'copilot',
            scriptedResult: {
              taskId: task.id,
              transport,
              toolCalls: [],
              toolResults: [],
              finalAnswer: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
              terminated: false,
              totalDurationMs: 0,
              totalRawBytes: 0,
              totalContentBytes: 0,
              estimatedTokens: { input: 0, output: 0 },
            },
            score: 0,
            scoreNotes: [
              `harness error: ${err instanceof Error ? err.message : String(err)}`,
            ],
            scoreTags: ['harness-error'],
          });
        }
      }
    }
  }
  return records;
}

async function isCopilotAvailable(): Promise<boolean> {
  try {
    const cmd = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
    execFileSync(cmd, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Run each transport's full task sequence in a single session so MCP's
  // ~2s startup is paid ONCE and amortized across all tasks - matching
  // how a real agent uses MCP.
  const cli = await runAllTasksOnTransport('cli');
  const mcp = await runAllTasksOnTransport('mcp');
  const scriptedRecords = [...cli.records, ...mcp.records];

  // Real-LLM matrix runs only when the copilot CLI is on PATH. Each
  // invocation spawns a fresh Copilot subprocess and costs ~10 premium
  // requests, so this gates on availability rather than running silently.
  const copilotPresent = await isCopilotAvailable();
  const copilotRecords = copilotPresent ? await runCopilotMatrix() : [];

  const md = renderResults(
    [...scriptedRecords, ...copilotRecords],
    {
      cli: cli.session,
      mcp: mcp.session,
    },
    { copilotPresent }
  );
  writeFileSync(RESULTS_PATH, md, 'utf8');
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
