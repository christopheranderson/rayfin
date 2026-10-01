/**
 * MCP adapter — long-lived `raymcp start` child + JSON-RPC tools/call. The
 * server is spawned once at task start, the initialize handshake runs once,
 * and every tool call reuses the same process — matching how a real
 * MCP-using agent works.
 *
 * For the negative-host task the adapter spawns a *separate* MCP child
 * with `--host-docs` when the agent calls list_docs/search_docs/get_doc
 * with `module: "host"`. (Otherwise the default-modules server returns
 * empty results and the agent can't resolve the question.) The orchestrator
 * decides when to switch shells, but the helper exposes both via
 * `defaultClient` and `hostClient`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { fileURLToPath } from 'url';

import {
  type AdapterMetrics,
  type DocsAdapter,
  type DocsToolCall,
  type DocsToolResult,
} from './adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const MCP_SCRIPT = resolve(
  REPO_ROOT,
  'packages',
  'tools',
  'mcp',
  'scripts',
  'main'
);
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 2_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

class JsonRpcClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly rl: ReadlineInterface;
  private readonly pending = new Map<
    number,
    {
      resolve: (r: { response: JsonRpcResponse; wireBytes: number }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly stderrChunks: string[] = [];
  private nextId = 1;
  private closed = false;

  constructor(extraArgs: string[]) {
    this.proc = spawn(process.execPath, [MCP_SCRIPT, 'start', ...extraArgs], {
      env: { ...process.env, RAYFIN_TELEMETRY_OPTOUT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stderr.on('data', (c: Buffer) => {
      this.stderrChunks.push(c.toString('utf8'));
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (typeof parsed.id !== 'number') return;
      const p = this.pending.get(parsed.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(parsed.id);
      p.resolve({
        response: parsed,
        wireBytes: Buffer.byteLength(line, 'utf8'),
      });
    });
    this.proc.on('exit', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP server exited unexpectedly'));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rayfin-llm-eval', version: '0.0.0' },
    });
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; rawBytes: number }> {
    const { response, wireBytes } = await this.request('tools/call', {
      name,
      arguments: args,
    });
    if (response.error) {
      throw new Error(`MCP tool error '${name}': ${response.error.message}`);
    }
    const text = response.result?.content?.[0]?.text ?? '';
    return { text, rawBytes: wireBytes };
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    this.proc.kill('SIGTERM');
    await new Promise<void>((res) => {
      const timer = setTimeout(() => {
        if (!this.closed) this.proc.kill('SIGKILL');
        res();
      }, SHUTDOWN_GRACE_MS);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        res();
      });
    });
    this.rl.close();
  }

  private async request(
    method: string,
    params: unknown
  ): Promise<{ response: JsonRpcResponse; wireBytes: number }> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params } as const;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(
          new Error(
            `MCP timeout method=${method}; stderr: ${this.stderrChunks.join('').slice(-200)}`
          )
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
}

export class McpAdapter implements DocsAdapter {
  readonly transport = 'mcp' as const;
  private defaultClient?: JsonRpcClient;
  private hostClient?: JsonRpcClient;
  private metricsState: AdapterMetrics = {
    totalCalls: 0,
    totalRawBytes: 0,
    totalContentBytes: 0,
    totalDurationMs: 0,
  };

  async start(): Promise<void> {
    // Lazy: spawn clients on first call.
  }

  async shutdown(): Promise<void> {
    if (this.defaultClient) await this.defaultClient.shutdown();
    if (this.hostClient) await this.hostClient.shutdown();
  }

  metrics(): AdapterMetrics {
    return { ...this.metricsState };
  }

  async call(toolCall: DocsToolCall): Promise<DocsToolResult> {
    const start = process.hrtime.bigint();
    const isHost =
      toolCall.arguments &&
      typeof toolCall.arguments === 'object' &&
      (toolCall.arguments as Record<string, unknown>).module === 'host';
    let client: JsonRpcClient;
    try {
      if (isHost) {
        if (!this.hostClient) {
          this.hostClient = new JsonRpcClient(['--host-docs']);
          await this.hostClient.initialize();
        }
        client = this.hostClient;
      } else {
        if (!this.defaultClient) {
          this.defaultClient = new JsonRpcClient([]);
          await this.defaultClient.initialize();
        }
        client = this.defaultClient;
      }
      // Keep the original arguments for fidelity with how an MCP agent
      // would call the tool; host calls are routed to the host-only server.
      const { text, rawBytes } = await client.callTool(
        toolCall.name,
        toolCall.arguments
      );
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      let content: unknown;
      let error: string | undefined;
      try {
        content = JSON.parse(text);
        if (
          content &&
          typeof content === 'object' &&
          'error' in (content as Record<string, unknown>)
        ) {
          error = String((content as Record<string, unknown>).error);
        }
      } catch {
        content = text;
      }
      const contentBytes = Buffer.byteLength(text, 'utf8');
      this.metricsState.totalCalls += 1;
      this.metricsState.totalRawBytes += rawBytes;
      this.metricsState.totalContentBytes += contentBytes;
      this.metricsState.totalDurationMs += durationMs;
      return {
        content,
        contentBytes,
        rawBytes,
        durationMs,
        ...(error ? { error } : {}),
      };
    } catch (err) {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: { error: message },
        contentBytes: 0,
        rawBytes: 0,
        durationMs,
        error: message,
      };
    }
  }
}
