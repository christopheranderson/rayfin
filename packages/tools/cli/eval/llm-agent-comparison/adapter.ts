/**
 * Transport adapter interface and tool surface for the LLM-agent eval.
 *
 * Both the CLI adapter (subprocess per call) and the MCP adapter
 * (long-lived child process) expose the same `DocsAdapter` interface so
 * the agent loop is transport-agnostic. The harness measures byte counts
 * and latency at this boundary so per-transport overhead is captured
 * even though the agent sees a normalized result shape.
 *
 * The rubber-duck pass on this design called out that controlled-parity
 * mode (normalized result shape, identical tool descriptions) and
 * realistic-surface mode (each transport's actual envelope) are
 * different evals. This adapter supports controlled-parity: it
 * normalizes results to a common shape but separately records the raw
 * wire/stdout bytes and parses durations so the realistic delta is
 * still observable in the metrics.
 */

export type DocsToolName = 'list_docs' | 'search_docs' | 'get_doc';

export interface DocsToolCall {
  name: DocsToolName;
  arguments: Record<string, unknown>;
}

export interface DocsToolResult {
  /**
   * The agent-visible content of the tool result. Always normalized to the
   * inner content from each transport (CLI's envelope inner field /
   * MCP's tool result text). Stable across transports for fair token
   * comparison.
   */
  content: unknown;
  /** Approximate JSON byte size of `content` after normalization. */
  contentBytes: number;
  /** Raw wire/stdout bytes the transport produced (envelope or JSON-RPC). */
  rawBytes: number;
  /** Wall-clock ms for the round trip from `call` start to result return. */
  durationMs: number;
  /** Optional error string if the call failed. */
  error?: string;
}

export interface DocsAdapter {
  readonly transport: 'cli' | 'mcp';
  /** Idempotent setup (e.g., spawn MCP server, perform initialize). */
  start(): Promise<void>;
  /** Execute a single tool call. */
  call(toolCall: DocsToolCall): Promise<DocsToolResult>;
  /** Tear down (kill MCP child, etc.). */
  shutdown(): Promise<void>;
  /** Return total bytes / call counts for reporting. */
  metrics(): AdapterMetrics;
}

export interface AdapterMetrics {
  totalCalls: number;
  totalRawBytes: number;
  totalContentBytes: number;
  totalDurationMs: number;
}
