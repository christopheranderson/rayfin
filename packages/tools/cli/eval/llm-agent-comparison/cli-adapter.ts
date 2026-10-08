/**
 * CLI adapter — spawns `node packages/tools/cli/scripts/main docs <op> --json`
 * per tool call. Records raw stdout bytes (the schemaVersion-wrapped JSON
 * envelope) and parses out the inner content for the agent.
 *
 * Each call is a fresh subprocess, mirroring how a real agent integration
 * would invoke the CLI in a process-per-call shape.
 */
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  type AdapterMetrics,
  type DocsAdapter,
  type DocsToolCall,
  type DocsToolName,
  type DocsToolResult,
} from './adapter.js';

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
const CLI_TIMEOUT_MS = 15_000;

function buildArgv(toolCall: DocsToolCall): string[] {
  const args = toolCall.arguments;
  switch (toolCall.name) {
    case 'list_docs': {
      const out = ['docs', 'list'];
      if (args.module) out.push('--module', String(args.module));
      out.push('--json');
      return out;
    }
    case 'search_docs': {
      const out = ['docs', 'search', String(args.query ?? '')];
      if (args.module) out.push('--module', String(args.module));
      if (args.scope) out.push('--scope', String(args.scope));
      if (args.limit) out.push('--limit', String(args.limit));
      out.push('--json');
      return out;
    }
    case 'get_doc': {
      const out = ['docs', 'get'];
      if (args.id) out.push('--id', String(args.id));
      else if (args.path) out.push('--path', String(args.path));
      else if (args.symbol) out.push('--symbol', String(args.symbol));
      if (args.module) out.push('--module', String(args.module));
      if (args.limit) out.push('--limit', String(args.limit));
      out.push('--json');
      return out;
    }
  }
}

/**
 * Strip the CLI's `{status, schemaVersion, ...}` envelope so the agent
 * sees the same shape as MCP returns. Records the raw envelope size
 * separately so the realistic-surface delta is still measurable.
 */
function extractCliInner(parsed: unknown, name: DocsToolName): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const obj = parsed as Record<string, unknown>;
  switch (name) {
    case 'list_docs':
      return obj.items ?? parsed;
    case 'search_docs':
      return obj.results ?? parsed;
    case 'get_doc':
      // get returns either { entry } (id/path) or { sections } (symbol).
      if ('entry' in obj) return obj.entry;
      if ('sections' in obj) return obj.sections;
      return parsed;
  }
}

export class CliAdapter implements DocsAdapter {
  readonly transport = 'cli' as const;
  private metricsState: AdapterMetrics = {
    totalCalls: 0,
    totalRawBytes: 0,
    totalContentBytes: 0,
    totalDurationMs: 0,
  };

  async start(): Promise<void> {
    // No-op; each call spawns its own subprocess.
  }

  async shutdown(): Promise<void> {
    // No-op.
  }

  metrics(): AdapterMetrics {
    return { ...this.metricsState };
  }

  async call(toolCall: DocsToolCall): Promise<DocsToolResult> {
    const argv = buildArgv(toolCall);
    return new Promise((resolveResult) => {
      const start = process.hrtime.bigint();
      const proc = spawn(process.execPath, [CLI_SCRIPT, ...argv], {
        env: { ...process.env, RAYFIN_TELEMETRY_OPTOUT: '1' },
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
      proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, CLI_TIMEOUT_MS);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const end = process.hrtime.bigint();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const rawBytes = Buffer.byteLength(stdout, 'utf8');
        const durationMs = Number(end - start) / 1_000_000;
        let content: unknown;
        let error: string | undefined;
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          if (parsed.status === 'error') {
            error = String(parsed.error ?? 'unknown error');
            content = parsed;
          } else {
            content = extractCliInner(parsed, toolCall.name);
          }
        } catch (err) {
          error = `non-JSON stdout (exit=${code}): ${
            err instanceof Error ? err.message : String(err)
          }; stderr tail: ${stderr.slice(-200)}`;
          content = { error };
        }
        const contentBytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
        this.metricsState.totalCalls += 1;
        this.metricsState.totalRawBytes += rawBytes;
        this.metricsState.totalContentBytes += contentBytes;
        this.metricsState.totalDurationMs += durationMs;
        resolveResult({
          content,
          contentBytes,
          rawBytes,
          durationMs,
          ...(error ? { error } : {}),
        });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        const end = process.hrtime.bigint();
        resolveResult({
          content: { error: err.message },
          contentBytes: 0,
          rawBytes: 0,
          durationMs: Number(end - start) / 1_000_000,
          error: err.message,
        });
      });
    });
  }
}
