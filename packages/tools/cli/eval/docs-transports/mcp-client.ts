/**
 * Minimal stdio JSON-RPC client for the Rayfin MCP server (FastMCP).
 *
 * No SDK dependency on purpose: the harness is supposed to measure the actual
 * wire-protocol overhead, not the SDK's. The protocol surface we use is tiny:
 *
 *   1. spawn the server process (`node packages/tools/mcp/scripts/main start`)
 *   2. send `initialize` and wait for the response
 *   3. send `notifications/initialized` (no response expected)
 *   4. for each query: send `tools/call`, match the response by `id`
 *   5. on shutdown: close stdin, send SIGTERM, kill on grace-period expiry
 *
 * The MCP `tools/call` response carries the operation result as text inside
 * `result.content[0].text` - that text is the JSON the tool returned.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolCallResult {
  /** The raw text payload returned by the tool. */
  text: string;
  /** Bytes of the raw text payload. */
  textBytes: number;
  /** Bytes of the entire JSON-RPC response line on the wire. */
  wireBytes: number;
  /** Parsed JSON content (undefined if the text was not JSON). */
  parsed: unknown;
}

const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;

export class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly rl: ReadlineInterface;
  private readonly pending = new Map<
    number,
    {
      resolve: (response: {
        response: JsonRpcResponse;
        wireBytes: number;
      }) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      method: string;
    }
  >();
  private readonly stderrChunks: string[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    serverScript: string,
    env: Record<string, string | undefined>,
    extraArgs: string[] = []
  ) {
    this.proc = spawn(process.execPath, [serverScript, 'start', ...extraArgs], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString('utf8'));
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Not JSON-RPC - ignore. fastmcp does not normally write non-JSON to
        // stdout, but defensive parse keeps us alive on stray output.
        return;
      }
      if (typeof parsed.id !== 'number') {
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      pending.resolve({
        response: parsed,
        wireBytes: Buffer.byteLength(line, 'utf8'),
      });
    });

    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `MCP server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}) ` +
              `with ${this.pending.size} pending request(s); last method=${pending.method}; ` +
              `stderr tail: ${this.stderrTail()}`
          )
        );
      }
      this.pending.clear();
    });
  }

  /** Run the MCP `initialize` + `notifications/initialized` handshake. */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rayfin-docs-eval', version: '0.0.0' },
    });
    // Notification - no id, no response expected.
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
  }

  /** Call a tool by name and return both the parsed payload and byte counts. */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const { response, wireBytes } = await this.request('tools/call', {
      name,
      arguments: args,
    });
    if (response.error) {
      throw new Error(
        `MCP error from tool '${name}': ${response.error.message}`
      );
    }
    const text = response.result?.content?.[0]?.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return {
      text,
      textBytes: Buffer.byteLength(text, 'utf8'),
      wireBytes,
      parsed,
    };
  }

  /** Cleanly stop the MCP server: stdin EOF, SIGTERM, kill after grace. */
  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed, fine.
    }
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.closed && this.proc.pid !== undefined) {
          // Final escape hatch: SIGKILL on POSIX, terminate on Windows.
          this.proc.kill('SIGKILL');
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.rl.close();
  }

  /** Tail of captured stderr - useful when debugging eval failures. */
  stderrTail(maxChars = 500): string {
    const joined = this.stderrChunks.join('');
    return joined.length > maxChars
      ? `...${joined.slice(joined.length - maxChars)}`
      : joined;
  }

  private async request(
    method: string,
    params: unknown
  ): Promise<{ response: JsonRpcResponse; wireBytes: number }> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request timed out after ${REQUEST_TIMEOUT_MS}ms (method=${method}); ` +
              `stderr tail: ${this.stderrTail()}`
          )
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
}
