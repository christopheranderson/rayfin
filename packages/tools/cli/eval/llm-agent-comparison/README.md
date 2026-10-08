# LLM-agent comparison eval

Compares how an agent solves docs-traversal tasks via the **CLI** transport (`rayfin docs`) versus the **MCP** transport (`@microsoft/rayfin-mcp`). Measures context size, token usage, tool-call count, wall-clock, and correctness against task-specific predicates.

## Mode

This harness ships in **controlled-parity mode**: both transports expose identical tool names (`list_docs`, `search_docs`, `get_doc`) and parameters to the agent. CLI envelope is stripped to its inner content before the agent sees it, so token comparisons reflect content shape — not envelope overhead. The raw transport bytes (CLI stdout, MCP JSON-RPC line) are recorded separately so the realistic-surface delta is still observable.

A planned future "realistic-surface mode" would expose each transport's actual surface (CLI's `--help` text, MCP's zod-described tools) without normalization. That mode is **not implemented in this round**.

## Agent

Two agent backends are wired:

1. **Scripted agent** (default, fully local) — deterministic per-task strategies that mimic the _shape_ of LLM tool-use behaviour without an actual LLM. Validates the pipeline end-to-end and provides baseline transport-level signals (raw bytes, content bytes, durations, tool-call counts). The strategies are hand-authored to produce a defensible answer for the rubric.
2. **Real-LLM agent** (GitHub Copilot CLI) — runs `copilot -p ... --output-format json --no-ask-user --allow-all-tools --log-level debug --log-dir <tmp>` once per (task, transport) when the `copilot` binary is on PATH. Parses the JSONL stream from stdout for per-turn structured data (tool requests, turn counts, per-message output tokens), and harvests the debug log for `assistant_usage` telemetry events to get full per-task input + cache_read + cache_write + output token totals. The agent's tool choices, reasoning, and termination are non-deterministic — re-running will produce slightly different numbers. No Anthropic key required.

## Transports

The real-LLM matrix runs every task on three transports:

- **`cli`** — agent uses Copilot's `bash` tool to invoke `node packages/tools/cli/scripts/main docs ...`.
  Each tool call is a fresh Node subprocess.
- **`mcp`** — agent wires the rayfin-docs MCP server via `--additional-mcp-config`.
  Copilot calls the structured `list_docs` / `search_docs` / `get_doc` tools directly.
- **`raw-docs`** — agent points at the package-owned markdown roots (`packages/guide/assets/docs`, `packages/typescript-sdk/*/assets/docs`, and `packages/host-docs/assets/docs`) and uses Copilot's built-in `bash`/`grep`/`read` against them.
  No specialised search API; the agent picks its own grep patterns and reads the files it finds.
  This is closest to how AI coding agents typically navigate codebases today.

## Tasks

Eight tasks in `tasks.ts`, spread across four tiers:

| ID                                            | Tier      | Kind       | Question (truncated)                                              |
| --------------------------------------------- | --------- | ---------- | ----------------------------------------------------------------- |
| `factual-dev-command`                         | factual   | answerable | What single command starts local Rayfin development?              |
| `factual-data-permissions-anonymous-read`     | factual   | answerable | How do I grant anonymous read-only access to an entity?           |
| `factual-graphql-mutation`                    | factual   | answerable | How do I run a GraphQL mutation through `@microsoft/rayfin-data`? |
| `synthesis-magic-link-react`                  | synthesis | answerable | How do I sign in with magic link in a React app + redirect?       |
| `synthesis-data-permissions-ownership`        | synthesis | answerable | How do I scope read/update/delete to a row's owner via JWT sub?   |
| `symbol-rayfinclient-config`                  | symbol    | answerable | What configuration does `RayfinClient` accept?                    |
| `negative-stripe-payments`                    | negative  | negative   | How do I integrate Stripe payments into a Rayfin app?             |
| `negative-realtime-subscriptions`             | negative  | negative   | How do I subscribe to realtime updates over WebSockets?           |

Each task has a `validate(answer, toolCalls, terminated) → { score, notes, tags }` predicate. The negative tasks are genuinely out of scope; passing means the agent reports the gap rather than fabricating an answer.

## Limits

Hard caps in `LIMITS`:

- `MAX_TOOL_CALLS = 15` — enforced. The scripted agent stops emitting calls past this; the Copilot prompt instructs the LLM to stop too.
- `MAX_TURNS = 20` — advisory; surfaced in tags as `excess-tool-calls` / `turn-cap-hit` when the agent gets close.
- `TASK_TIMEOUT_MS = 120_000` — advisory; the real Copilot subprocess has its own 5-minute hard timeout in `copilot-agent.ts`.

## Scoring

Per-task predicates run substring matches, tool-call inspection, and forbidden-claim checks. Score is 0.0–1.0; **threshold ≥ 0.75 = passed**. Failure tags (e.g., `missing-citation`, `forbidden-host-claim`, `excess-tool-calls`, `path-a-success`) categorize the run for iteration signal.

## Running

From `packages/tools/cli`:

```powershell
rushx eval:llm-agent
```

Prerequisites:

- `@microsoft/rayfin-cli` and `@microsoft/rayfin-mcp` built (`rushx build` in each).
- The package docs roots are present in the workspace packages being evaluated.

Output:

- `RESULTS.md` next to this README.
- Stdout dump of the same.

## Files

- `tasks.ts` — task list, validation predicates, hard caps.
- `adapter.ts` — `DocsAdapter` interface + tool-result type shared by both transports.
- `cli-adapter.ts` — spawns `node cli/scripts/main docs ... --json` per call; strips envelope.
- `mcp-adapter.ts` — long-lived `raymcp start` child + JSON-RPC `tools/call`.
- `scripted-agent.ts` — deterministic strategies + token estimation (1-token≈4-chars). The orchestrator (not the strategies) owns adapter `start()` / `shutdown()` so MCP startup is paid once per transport per session, not per task.
- `copilot-agent.ts` — drives `copilot -p ... --output-format json --log-level debug --log-dir <tmp>` for real-LLM runs. Two-source parsing: JSONL on stdout for per-turn structure (tool requests, turn counts, output tokens per message), plus harvests `assistant_usage` telemetry events from the debug log for per-task input + cache_read + cache_write totals. Returns `ScriptedRunResult` shape plus `CopilotRunMetadata` (input/output/cached/cacheWrite/reasoning tokens, turns, tool requests).
- `eval.ts` — orchestrator. Runs scripted matrix first, then copilot matrix if available, scores both, writes `RESULTS.md`.
- `RESULTS.md` — committed snapshot.

## Limitations called out by the rubber-duck pass

- **Scripted strategies don't capture LLM variance.** A real LLM may use more turns, search wider, retry, or hallucinate. The token/turn deltas surfaced in the scripted-baseline rows are floors, not real-world numbers.
- **N=1 for real-LLM runs.** Copilot's tool choices are non-deterministic; the real-LLM rows are a pilot, not a statistically rigorous comparison. Each `copilot -p` invocation reports a flat `premiumRequests: 10` regardless of work done, so we omit it from the comparison table — it's a session billing unit, not a real measure of LLM compute. The actual signal is the captured ↑input/↓output/cached/cache_write token totals.
- **Tool results aren't captured for real-LLM rows.** Copilot's JSONL emits `tool_request` events but the corresponding result is folded into the next assistant message (we record the request count + structured args but not per-result bytes/duration).
- **Per-task token totals come from Copilot's debug log**, not from the JSONL stream itself. The debug log is at `--log-dir <tmp>` (auto-cleaned after parsing); each LLM call writes one `assistant_usage` telemetry event with a `metrics` block containing `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`. We sum across events.
- **Three tasks is a pilot, not a full eval.** Confidence in the methodology comes first; scaling the task set to 10 + N=3 runs is the next step once the pipeline is validated.
