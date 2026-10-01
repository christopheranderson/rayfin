---
name: rayfin-cli-ux
description: >-
  Mandatory for Rayfin CLI UX work. Load before designing, speccing,
  implementing, or reviewing CLI commands, flags, output, or errors.
---

# Rayfin CLI UX Guidelines

Standards for consistent, high-quality CLI experiences in `@microsoft/rayfin-cli`.

**Full reference**: [references/cli-ux-guidelines.md](./references/cli-ux-guidelines.md) — load on demand for depth, examples, and rationale.

## Architecture Status

These rules define *what* a good CLI experience must deliver — they stay in force regardless of wiring.
*How* output is wired is mid-migration to the workflow + adapter architecture ([`docs/rfc/rayfin-tools-architecture.md`](../../../docs/rfc/rayfin-tools-architecture.md), tracked in [`rayfin-tools-architecture-migration.md`](../../../docs/rfc/rayfin-tools-architecture-migration.md)).

- **New or migrated commands** use a `common/src/workflows/<name>/` workflow returning a typed `Result<T>`, with a thin Layer-1 Commander wrapper rendering via `Logger`/`Progress` adapters selected from `--output <mode>`. Do **not** import `output-mode.ts`, branch on raw `--json`/`--verbose`, or use `CliHandledError`/`process.exit`.
- **Legacy (un-migrated) commands** use `output-mode.ts` (`modeLog`/`emitJson`/`resolveOutputMode`). This machinery is scheduled for removal in Phase 6.
- When this skill and the architecture RFC disagree, the RFC wins.

## Constitutional Rules

Non-negotiable for every CLI command. Each rule has a stable ID (R1–R12) for cross-referencing.

| ID | Rule | One-liner |
|----|------|-----------|
| R1 | Three output modes | Every command supports `interactive`, `plain`, and `json`. See [reference §1](./references/cli-ux-guidelines.md). |
| R2 | No `console.log` | All output goes through mode-aware utilities (or v2 `Logger`/`Progress` adapters). |
| R3 | Recovery hints | Every `❌` error includes an indented next-step action. |
| R4 | `--force` for destructive ops | Operations risking data loss fail by default; `--force` opts in. |
| R5 | Respect non-interactive | No prompts when `--yes`, non-TTY stdin, or `CI=true`. |
| R6 | Valid JSON output | `--json` → exactly one JSON object on stdout, no ANSI/emoji. `--verbose` + `--json` → reject with error. |
| R7 | Standard flags | `--output <mode>` (canonical), `--json` (shorthand), `-y/--yes`, `--verbose`, `--dry-run`, `--force`, `--env-file <path>`. |
| R8 | Clear progress text | Every step uses `ProgressIndicator` with action-oriented text. |
| R9 | No credentials/PII | Truncate tokens, use boolean indicators, never log emails/OIDs. |
| R10 | `--dry-run` explains | Lists planned ops without mutations; viable previews exit `0`, validation failures exit nonzero. |
| R11 | `--help` everywhere | `.description()` on every command/option/argument. See [reference §5](./references/cli-ux-guidelines.md) for canonical descriptions. |
| R12 | Semantic exit codes | `0` = success, `1` = error, `2` = cancelled. |

## Decision Shortcuts

- "Command or flag?" → Changes **what** = command. Changes **how** = flag.
- "`dev` or `up`?" → Local Docker / no auth → `dev`. Authenticated cloud → `up`.
- "Child service or connector?" → Owned/deployed with app → `rayfin <service> init`. External → `rayfin connector add`.
- "`init` create this?" → Only minimal base app (auth, data, static). Otherwise explicit follow-up command.
- "Implicit?" → Only required system actions in `dev`/`up`. User-facing = explicit.

## Common Patterns (keep — action-oriented)

### Standard action handler (legacy path)

```typescript
.action(async (cmdOptions) => {
  const mode = resolveOutputMode({ json: cmdOptions.json });
  const interactive = isInteractive({ yes: cmdOptions.yes });
  const verbose = createVerboseLogger(cmdOptions.verbose);

  try {
    // ...work...
    if (mode === 'json') {
      emitJson({ status: 'success', ...result });
    }
  } catch (err) {
    if (mode === 'json') {
      emitJsonError(mode, (err as Error).message);
    }
    modeError(mode, `❌ ${(err as Error).message}`);
    modeError(mode, '   <recovery hint>');
    throw new CliHandledError(err);
  }
})
```

### Error with recovery hint

```typescript
modeError(mode, '❌ Project name not found in rayfin.yml configuration');
modeError(mode, "   Run 'rayfin init' to create a new project configuration");
throw new CliHandledError(new Error('...'));
```

### Progress step

```typescript
const spinner = showProgress('Deploying configuration', '🔄', mode);
try {
  await doWork();
  spinner.succeed('Configuration deployed');
} catch (err) {
  spinner.fail('Configuration deployment failed');
  throw err;
}
```

## Implementing a New Command

> **First decide: v2 workflow or legacy path?** New commands target the workflow + adapter architecture (see [migration plan](../../../docs/rfc/rayfin-tools-architecture-migration.md)).
> The legacy steps below are for un-migrated commands only.

**V2 command** (preferred): orchestration in `common/src/workflows/<name>/`, Commander `.action()` is a thin wrapper that parses → builds deps → calls workflow → renders `Result` via adapters → maps exit code.

**Legacy path** (un-migrated commands):

1. Create command file in `packages/tools/cli/src/commands/`.
2. Import utilities from `../utils/output-mode.js`.
3. Add `--json`, `-y/--yes`, `--verbose` options.
4. Add `--dry-run`/`--force` when applicable.
5. Wrap progress in `ProgressIndicator`.
6. Follow the standard action handler skeleton above.
7. Register in parent `index.ts`.

## Reviewing a Command (checklist by rule ID)

- [ ] R1 — supports interactive, plain, json modes
- [ ] R2 — no bare `console.log`
- [ ] R3 — every `❌` has a recovery hint
- [ ] R6 — `--json` emits valid JSON only; no ANSI/emoji
- [ ] R4 — destructive ops gated on `--force`
- [ ] R5 — prompts respect `isInteractive()`
- [ ] R8 — progress uses `ProgressIndicator` with action text
- [ ] R10 — `--dry-run` lists ops without mutations and uses a semantic exit code
- [ ] R9 — no PII in verbose output
- [ ] R11 — `--help` descriptions present, canonical wording for standard flags
- [ ] R12 — exit codes are semantic
- [ ] Spec includes user intent, behavior contract, validation/failures, error wording, examples, cross-cutting impacts

## Command Topology: `dev` vs `up`

See [reference §12](./references/cli-ux-guidelines.md) for full rationale and patterns.

Key rules:

1. Mirror nouns under both `dev` and `up` when capability exists in both worlds.
2. `dev` = local Docker, offline, single env, lifecycle via flags (`--stop`, `--down`, etc.).
3. `up` = Fabric cloud, requires auth (except inspection), multi-env via subcommands.
4. `dev` never authenticates. Inspection commands (`status`, `list`) never block on auth.
5. `--force` means "allow destructive schema changes" — not "skip prompt" (that's `--yes`).

## Pre-flight Checklist (OpenSpec CLI changes)

Every `tasks.md` for a CLI-touching OpenSpec change MUST begin with this block:

```markdown
## Pre-flight

- [ ] Loaded `.github/skills/rayfin-cli-ux/SKILL.md`. Cite one rule applied: <ID and restatement>.
- [ ] Loaded `.github/skills/rayfin-cli-ux/references/cli-ux-guidelines.md`. Cite one section: <name>.
- [ ] Every new/changed command, option, argument has a `.description()` (R11).
- [ ] Every `❌` error has a recovery hint (R3).
- [ ] All three output modes covered in scenarios (R1).
- [ ] Destructive ops gated on `--force` (R4).
- [ ] Non-interactive behavior preserved (R5).
- [ ] `dev` vs `up` topology rules respected if adding lifecycle commands.
```

## Final Scan (Guardrails)

Before submitting, verify none of the NEVER/ALWAYS rules are violated:

- NEVER: bare `console.log` (R2), prompt when non-interactive (R5), partial/multiple JSON (R6), error without recovery (R3), destructive without `--force` (R4), PII in logs (R9), emoji outside interactive (R1), mutating API calls in dry-run (R10), auth in `dev` commands.
- ALWAYS: action-oriented progress text (R8), standard flag names (R7), mirror `dev`/`up` nouns, regenerate `.env.local` after lifecycle commands.

Dry-run reads require an explicit documented contract.
`rayfin up` authenticates and reads workspace metadata so its preview can identify the resolved target; it validates local static inputs first and never runs builds or deployment writes.
See reference section 7 for this exception to the otherwise offline dry-run contract.
