/**
 * Docs-transport eval harness.
 *
 * Compares the `rayfin docs` CLI command group with the `@microsoft/rayfin-mcp`
 * server transport on the same set of representative queries, reporting:
 *
 *   - Content equivalence (CLI envelope inner content vs MCP tool result text)
 *   - Latency (min/median/max/mean over RUNS_PER_QUERY samples)
 *   - Stdout/wire byte counts
 *
 * The harness is deliberately *manual*: not run in CI, not a regression gate.
 * See ./README.md for the full reproduction recipe.
 *
 * Telemetry opt-out (`RAYFIN_TELEMETRY_OPTOUT=1`) is forced on both transports
 * so the CLI's per-call telemetry init does not contaminate transport latency.
 */
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { hostname, platform, release } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import { discoverRayfinDocsPackages } from '@microsoft/rayfin-docs';

import { McpClient, type ToolCallResult } from './mcp-client.js';
import { ERROR_QUERIES, QUERIES, type DocsQuery } from './queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const CLI_PKG = resolve(REPO_ROOT, 'packages', 'tools', 'cli');
const MCP_PKG = resolve(REPO_ROOT, 'packages', 'tools', 'mcp');
const CLI_SCRIPT = resolve(CLI_PKG, 'scripts', 'main');
const MCP_SCRIPT = resolve(MCP_PKG, 'scripts', 'main');
const RESULTS_PATH = resolve(HERE, 'RESULTS.md');

const RUNS_PER_QUERY = 15;
const WARMUP_RUNS = 2;
const CLI_TIMEOUT_MS = 15_000;

interface CliInvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  parsed: unknown;
  durationMs: number;
}

interface PerTransportStats {
  samples: number;
  min: number;
  median: number;
  max: number;
  mean: number;
  bytesMedian: number;
}

interface QueryReport {
  id: string;
  description: string;
  suite: 'default' | 'host';
  op: string;
  cli: PerTransportStats;
  mcpCold: number | null;
  mcpWarm: PerTransportStats;
  equivalence: 'pass' | 'fail' | 'skipped';
  equivalenceNote?: string;
}

interface ErrorQueryReport {
  id: string;
  description: string;
  cliExitCode: number;
  cliStdout: string;
  mcpText: string;
}

function ensureBuiltOrFail(): void {
  const missing: string[] = [];
  if (!existsSync(resolve(CLI_PKG, 'dist', 'index.js'))) {
    missing.push(
      'packages/tools/cli/dist (run `rushx build` in packages/tools/cli)'
    );
  }
  if (!existsSync(resolve(MCP_PKG, 'dist', 'index.js'))) {
    missing.push(
      'packages/tools/mcp/dist (run `rushx build` in packages/tools/mcp)'
    );
  }
  if (missing.length > 0) {
    console.error('eval prerequisites missing:');
    for (const m of missing) {
      console.error(`  - ${m}`);
    }
    process.exit(2);
  }
}

function buildSpawnEnv(): Record<string, string | undefined> {
  return { ...process.env, RAYFIN_TELEMETRY_OPTOUT: '1' };
}

async function runCliOnceAsync(query: DocsQuery): Promise<CliInvocationResult> {
  return new Promise((resolveResult, rejectResult) => {
    const start = process.hrtime.bigint();
    const proc = spawn(
      process.execPath,
      [CLI_SCRIPT, 'docs', query.op, ...query.cliArgs],
      {
        env: buildSpawnEnv(),
        windowsHide: true,
      }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rejectResult(
        new Error(
          `CLI invocation timed out after ${CLI_TIMEOUT_MS}ms for query '${query.id}'`
        )
      );
    }, CLI_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const end = process.hrtime.bigint();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      resolveResult({
        exitCode: code ?? -1,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        parsed,
        durationMs: Number(end - start) / 1_000_000,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
  });
}

async function runMcpOnce(
  client: McpClient,
  query: DocsQuery
): Promise<{ result: ToolCallResult; durationMs: number }> {
  const start = process.hrtime.bigint();
  const result = await client.callTool(query.mcp.tool, query.mcp.args);
  const end = process.hrtime.bigint();
  return { result, durationMs: Number(end - start) / 1_000_000 };
}

function summarize(
  samples: { duration: number; bytes: number }[]
): PerTransportStats {
  if (samples.length === 0) {
    return { samples: 0, min: 0, median: 0, max: 0, mean: 0, bytesMedian: 0 };
  }
  const durations = samples.map((s) => s.duration).sort((a, b) => a - b);
  const bytes = samples.map((s) => s.bytes).sort((a, b) => a - b);
  const median = (xs: number[]): number => {
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
  };
  const mean = durations.reduce((acc, d) => acc + d, 0) / durations.length;
  return {
    samples: durations.length,
    min: durations[0],
    median: median(durations),
    max: durations[durations.length - 1],
    mean,
    bytesMedian: Math.round(median(bytes)),
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null || typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(b)) {
    return false;
  }
  const aKeys = Object.keys(a as object).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    return false;
  }
  for (const key of aKeys) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    ) {
      return false;
    }
  }
  return true;
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

function readPkgVersion(pkgDir: string): string {
  try {
    const text = readFileSync(resolve(pkgDir, 'package.json'), 'utf8');
    return (JSON.parse(text) as { version?: string }).version ?? '<unknown>';
  } catch {
    return '<unknown>';
  }
}

function stripJsonComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function getWorkspacePackageRoots(): string[] {
  const rushJson = JSON.parse(
    stripJsonComments(readFileSync(resolve(REPO_ROOT, 'rush.json'), 'utf8'))
  ) as { projects?: Array<{ projectFolder?: unknown }> };
  return (rushJson.projects ?? [])
    .map((project) => project.projectFolder)
    .filter((projectFolder): projectFolder is string => !!projectFolder)
    .map((projectFolder) => resolve(REPO_ROOT, projectFolder));
}

function corpusStats(): { files: number; bytes: number; sha256: string } {
  let files = 0;
  let bytes = 0;
  const hash = createHash('sha256');
  const collected: { path: string; bytes: number }[] = [];
  const walk = (root: string, dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(root, full);
      } else if (entry.isFile()) {
        const size = statSync(full).size;
        files += 1;
        bytes += size;
        collected.push({
          path: relative(root, full).replace(/\\/g, '/'),
          bytes: size,
        });
      }
    }
  };
  const discovered = discoverRayfinDocsPackages({
    from: REPO_ROOT,
    packageRoots: getWorkspacePackageRoots(),
  }).discovered;
  for (const pkg of discovered) {
    const root = resolve(pkg.packageRoot, pkg.manifest.dir);
    if (existsSync(root)) {
      walk(root, root);
    }
  }
  // Hash the *list* of files, not their content - much faster, still detects
  // any add/remove/rename. Suitable for "did the corpus change between runs".
  collected.sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of collected) {
    hash.update(`${entry.path}:${entry.bytes}\n`);
  }
  return { files, bytes, sha256: hash.digest('hex').slice(0, 16) };
}

function fmtMs(value: number): string {
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

function fmtBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  return `${(value / 1024).toFixed(1)} KiB`;
}

async function runQuerySuite(
  suite: 'default' | 'host',
  client: McpClient,
  reports: QueryReport[],
  equivalenceFailures: string[]
): Promise<void> {
  const queries = QUERIES.filter((q) => q.suite === suite);
  for (const query of queries) {
    console.error(`[${suite}] ${query.id}`);
    const cliSamples: { duration: number; bytes: number }[] = [];
    const mcpSamples: { duration: number; bytes: number }[] = [];
    let mcpCold: number | null = null;
    let firstCliParsed: unknown;
    let firstMcpParsed: unknown;

    for (let i = 0; i < WARMUP_RUNS + RUNS_PER_QUERY; i += 1) {
      const cli = await runCliOnceAsync(query);
      const mcp = await runMcpOnce(client, query);

      if (i === 0) {
        mcpCold = mcp.durationMs;
        firstCliParsed = cli.parsed;
        firstMcpParsed = mcp.result.parsed;
      }

      if (i >= WARMUP_RUNS) {
        cliSamples.push({ duration: cli.durationMs, bytes: cli.stdoutBytes });
        mcpSamples.push({
          duration: mcp.durationMs,
          bytes: mcp.result.textBytes,
        });
      }
    }

    let equivalence: 'pass' | 'fail' | 'skipped' = 'skipped';
    let equivalenceNote: string | undefined;
    if (firstCliParsed !== undefined && firstMcpParsed !== undefined) {
      const cliInner = query.extractCli(firstCliParsed);
      const mcpInner = query.extractMcp(firstMcpParsed);
      equivalence = deepEqual(cliInner, mcpInner) ? 'pass' : 'fail';
      if (equivalence === 'fail') {
        equivalenceFailures.push(query.id);
        const cliBytes =
          cliInner === undefined
            ? 'undefined'
            : `${JSON.stringify(cliInner)?.length ?? 'n/a'}`;
        const mcpBytes =
          mcpInner === undefined
            ? 'undefined'
            : `${JSON.stringify(mcpInner)?.length ?? 'n/a'}`;
        equivalenceNote = `cli inner bytes=${cliBytes}, mcp inner bytes=${mcpBytes}`;
      }
    } else {
      equivalenceNote = 'one or both transports returned non-JSON';
    }

    reports.push({
      id: query.id,
      description: query.description,
      suite,
      op: query.op,
      cli: summarize(cliSamples),
      mcpCold,
      mcpWarm: summarize(mcpSamples),
      equivalence,
      equivalenceNote,
    });
  }
}

async function main(): Promise<void> {
  ensureBuiltOrFail();

  const corpus = corpusStats();
  const cliVersion = readPkgVersion(CLI_PKG);
  const mcpVersion = readPkgVersion(MCP_PKG);
  const sha = gitSha();
  const dirty = gitDirty();

  const reports: QueryReport[] = [];
  const errorReports: ErrorQueryReport[] = [];
  const equivalenceFailures: string[] = [];

  // --- Default suite: MCP started with no flags (loads guide+ts-sdk).
  const defaultClient = new McpClient(MCP_SCRIPT, buildSpawnEnv());
  await defaultClient.initialize();

  try {
    await runQuerySuite('default', defaultClient, reports, equivalenceFailures);

    for (const query of ERROR_QUERIES) {
      console.error(`[error] ${query.id}`);
      const cli = await runCliOnceAsync(query);
      const mcp = await runMcpOnce(defaultClient, query);
      errorReports.push({
        id: query.id,
        description: query.description,
        cliExitCode: cli.exitCode,
        cliStdout: cli.stdout.trim().slice(0, 240),
        mcpText: mcp.result.text.trim().slice(0, 240),
      });
    }
  } finally {
    await defaultClient.shutdown();
  }

  // --- Host suite: separate MCP with --host-docs (loads host only).
  const hostQueries = QUERIES.filter((q) => q.suite === 'host');
  if (hostQueries.length > 0) {
    const hostClient = new McpClient(MCP_SCRIPT, buildSpawnEnv(), [
      '--host-docs',
    ]);
    await hostClient.initialize();
    try {
      await runQuerySuite('host', hostClient, reports, equivalenceFailures);
    } finally {
      await hostClient.shutdown();
    }
  }

  const md = renderResults({
    reports,
    errorReports,
    equivalenceFailures,
    metadata: {
      sha,
      dirty,
      node: process.version,
      platform: `${platform()}-${release()}`,
      hostname: hostname(),
      cliVersion,
      mcpVersion,
      corpus,
      runsPerQuery: RUNS_PER_QUERY,
      warmupRuns: WARMUP_RUNS,
      timestamp: new Date().toISOString(),
    },
  });

  writeFileSync(RESULTS_PATH, md, 'utf8');
  console.log(md);

  if (equivalenceFailures.length > 0) {
    console.error(
      `\n⚠ ${equivalenceFailures.length} content-equivalence failure(s): ` +
        equivalenceFailures.join(', ')
    );
    process.exitCode = 1;
  }
}

interface RenderInput {
  reports: QueryReport[];
  errorReports: ErrorQueryReport[];
  equivalenceFailures: string[];
  metadata: {
    sha: string;
    dirty: boolean;
    node: string;
    platform: string;
    hostname: string;
    cliVersion: string;
    mcpVersion: string;
    corpus: { files: number; bytes: number; sha256: string };
    runsPerQuery: number;
    warmupRuns: number;
    timestamp: string;
  };
}

function renderResults(input: RenderInput): string {
  const { metadata: m, reports, errorReports, equivalenceFailures } = input;
  const passes = reports.filter((r) => r.equivalence === 'pass').length;
  const fails = reports.filter((r) => r.equivalence === 'fail').length;
  const skipped = reports.filter((r) => r.equivalence === 'skipped').length;

  const lines: string[] = [];
  lines.push('<!-- markdownlint-disable-file -->');
  lines.push('');
  lines.push('# `rayfin docs` transport eval results');
  lines.push('');
  lines.push(
    'Generated by `packages/tools/cli/eval/docs-transports/eval.ts`. ' +
      'Manual harness; not run in CI; results are a local snapshot.'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `- Content equivalence: **${passes}/${reports.length} passed**, ${fails} failed, ${skipped} skipped.`
  );
  if (equivalenceFailures.length > 0) {
    lines.push(
      `  - Failed: ${equivalenceFailures.map((id) => `\`${id}\``).join(', ')}`
    );
  }
  lines.push(
    `- Latency: ${RUNS_PER_QUERY} samples per query (after ${WARMUP_RUNS} warmup runs), CLI cold per call, MCP warm after first call.`
  );
  lines.push(
    `- Telemetry: \`RAYFIN_TELEMETRY_OPTOUT=1\` forced in spawn env for both transports.`
  );
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Git SHA | \`${m.sha}\`${m.dirty ? ' (dirty)' : ''} |`);
  lines.push(`| Node | \`${m.node}\` |`);
  lines.push(`| Platform | \`${m.platform}\` |`);
  lines.push(`| @microsoft/rayfin-cli | \`${m.cliVersion}\` |`);
  lines.push(`| @microsoft/rayfin-mcp | \`${m.mcpVersion}\` |`);
  lines.push(
    `| Docs corpus | ${m.corpus.files} files, ${(m.corpus.bytes / 1024).toFixed(1)} KiB, sha256 prefix \`${m.corpus.sha256}\` |`
  );
  lines.push(`| Runs per query | ${m.runsPerQuery} |`);
  lines.push(`| Warmup runs (discarded) | ${m.warmupRuns} |`);
  lines.push(`| Generated at | ${m.timestamp} |`);
  lines.push('');
  lines.push('## Latency by query');
  lines.push('');
  lines.push(
    '| Query | Suite | Op | CLI median (ms) | CLI mean (ms) | CLI min/max (ms) | MCP cold (ms) | MCP warm median (ms) | MCP warm mean (ms) | Equivalence |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of reports) {
    const cli = r.cli;
    const mcp = r.mcpWarm;
    const eq =
      r.equivalence === 'pass'
        ? '✅ pass'
        : r.equivalence === 'fail'
          ? '❌ fail'
          : '➖ skipped';
    lines.push(
      `| \`${r.id}\` | ${r.suite} | ${r.op} | ${fmtMs(cli.median)} | ${fmtMs(cli.mean)} | ${fmtMs(cli.min)} / ${fmtMs(cli.max)} | ${
        r.mcpCold === null ? '—' : fmtMs(r.mcpCold)
      } | ${fmtMs(mcp.median)} | ${fmtMs(mcp.mean)} | ${eq} |`
    );
  }
  lines.push('');
  lines.push('## Payload size by query (median bytes)');
  lines.push('');
  lines.push('| Query | Suite | CLI stdout | MCP tool text |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of reports) {
    lines.push(
      `| \`${r.id}\` | ${r.suite} | ${fmtBytes(r.cli.bytesMedian)} | ${fmtBytes(r.mcpWarm.bytesMedian)} |`
    );
  }
  if (errorReports.length > 0) {
    lines.push('');
    lines.push('## Error-path behaviour');
    lines.push('');
    lines.push(
      'Latency for failing inputs is not aggregated - the table just records observable behaviour.'
    );
    lines.push('');
    lines.push(
      '| Query | CLI exit | CLI stdout (truncated) | MCP tool text (truncated) |'
    );
    lines.push('| --- | --- | --- | --- |');
    for (const e of errorReports) {
      lines.push(
        `| \`${e.id}\` | ${e.cliExitCode} | ${markdownTableCode(e.cliStdout)} | ${markdownTableCode(e.mcpText)} |`
      );
    }
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- "CLI cold per call" means every CLI sample pays Node startup, package discovery, markdown parsing, and index construction. `DocsService` serves docs from the Rayfin packages installed in the current project so results stay version-locked to the APIs the app can actually use.'
  );
  lines.push(
    '- The MCP server pays Node startup and index load once at spawn and reuses everything across requests, hence the ~10 ms warm latency.'
  );
  lines.push(
    '- The harness deep-equals the CLI envelope inner content (e.g. `items`, `results`, `entry`, `sections`) against the parsed MCP tool result. Equivalence failures should be treated as bugs, not as expected drift.'
  );
  lines.push(
    '- Install footprint (tarball/disk size, transitive dep tree) is intentionally out of scope for this harness. See `openspec/changes/rayfin-docs-cli/design.md` for the leaf-package follow-up (F1) that targets the unused-dep tax.'
  );
  lines.push('');

  return lines.join('\n');
}

function markdownTableCode(value: string): string {
  return `\`${value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/`/g, "'")
    .replace(/\|/g, '&#124;')}\``;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
