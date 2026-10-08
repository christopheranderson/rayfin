# Docs-transport eval harness

This harness is a manual, reproducible comparison between the two transports that expose Rayfin's installed package docs to agents and humans:

- **CLI:** `rayfin docs list|search|get` (process-per-call, JSON envelope).
- **MCP server:** `@microsoft/rayfin-mcp` (FastMCP, stdio JSON-RPC, persistent process).

Both transports route through the same `DocsService` implementation, so they should return identical content for identical queries against the same workspace package set. The harness:

1. Deep-equals the CLI envelope inner content against the parsed MCP tool result for each query (the **equivalence** check).
2. Times each transport over `RUNS_PER_QUERY = 15` samples (after `WARMUP_RUNS = 2` discarded warmups) and reports min / median / max / mean.
3. Records median stdout / wire payload size per query.
4. Writes a `RESULTS.md` snapshot with full provenance (git SHA, Node version, OS, package versions, corpus byte/file count and a sha256 prefix).

The harness is **manual**, not run in CI, and not a regression gate. It exists so future contributors can confirm the two transports stay in sync on content and characterize the latency difference when changes land on either side.

## Reproducing a run

The harness needs the CLI and the MCP server packages built first. From the repo root:

```powershell
# Install workspace deps for the CLI subspace.
rush update --subspace rayfin-cli

# Build cli + mcp.
rushx build      # from packages/tools/mcp
rushx build      # from packages/tools/cli

# Run the harness.
rushx eval:docs-transports   # from packages/tools/cli
```

The harness reads docs through the installed Rayfin packages discovered by `@microsoft/rayfin-docs`.
Run it from a workspace with the packages you want to measure installed; use the docs cache state intentionally when comparing cold and warm behavior.

The harness is a TypeScript ESM script run via `tsx`. It does **not** import any test runner; it is intentionally orthogonal to vitest.

## Output

`RESULTS.md` is written next to this README and printed to stdout. It contains:

1. **Summary** — pass/fail count for content equivalence and the run parameters.
2. **Environment** — git SHA + dirty flag, Node version, platform, package versions, corpus stats, run params, timestamp.
3. **Latency by query** — per-query CLI median / mean / min / max, MCP cold-start (first call after spawn), MCP warm median / mean, and the equivalence verdict.
4. **Payload size by query** — median stdout bytes (CLI) and median tool text bytes (MCP).
5. **Error-path behaviour** — observable shape of failure responses (CLI exit code + stdout, MCP tool text). Latency for these is not aggregated.

The exit code is `1` if any equivalence check failed; otherwise `0`.

## Telemetry

The spawn environment for both transports forces `RAYFIN_TELEMETRY_OPTOUT=1`, so the CLI's per-call telemetry initialization does not contaminate the transport latency numbers. This is documented in `RESULTS.md`'s environment table.

## Where to add or change queries

`queries.ts` exports two arrays:

- `QUERIES` — ten representative success-path queries (list, get-by-id, get-by-symbol, search variants).
- `ERROR_QUERIES` — small set of failing inputs whose response shapes are recorded but whose latency is not aggregated.

Each entry pairs the CLI argv tail and the MCP `tools/call` shape, plus per-operation extractors that strip the transport envelope down to the inner content for a faithful equivalence check. Don't normalize fields inside the inner content - the harness should flag any drift, not paper over it.

## Caveats

- Bytes-on-the-wire are reported as the median of the JSON-RPC line for MCP and the median of CLI stdout for CLI. They measure different things by definition (the MCP line includes the JSON-RPC envelope) - use them for direction, not absolute comparison.
- Latency depends on disk cache state; the warmup runs are intended to neutralize cold-cache effects but do not fully control for them.
- N=15 is small. Treat the table as directional rather than statistically authoritative.
