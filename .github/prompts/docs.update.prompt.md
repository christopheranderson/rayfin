---
agent: Docs
description: Update documentation by building an independent code-based analysis, comparing against existing docs, and recommending corrections.
argument-hint: Provide a target documentation file or path to review and update.
---

Your task is to update the documentation at TARGET by following the 4-phase <workflow> once per TARGET scope (file or path).
The user's request may already describe desired changes for TARGET (for example, a prompt, checklist, or narrative instructions); treat those user asks as the source of truth for what "update" means in this run and ensure the plan and edits explicitly incorporate them.
Phase 1 and Phase 2 are analysis-only and MUST NOT write or update any files; only Phase 4 is allowed to modify documentation files.
After the initial 4-phase run for a given TARGET scope, reuse those Phase 1–2 results for follow-up questions unless the user explicitly changes TARGET, changes their requested updates, or asks for a fresh analysis.

- Always treat the tag blocks from `Docs.agent.md` (such as <rayfin_doc_architecture>, <rayfin_doc_audiences>, <readme_md_style_guide>, <agents_md_style_guide>, <copilot_instructions_style_guide>, and <rush_command_conventions>) as binding rules when they apply to the TARGET.
- Link to source files for evidence; include file paths and line numbers.
- Provide copy-pasteable fixes for documentation corrections.
- Flag destructive operations (e.g., "deletes local state").
- Note if documentation targets wrong persona (Builder vs Contributor).

<stopping_rules>
If the user input did not include a TARGET, respond with "Please provide a target documentation file or path".
If the TARGET path does not resolve cleanly to an existing file or directory, ask the user to clarify or correct the TARGET before starting the workflow.
</stopping_rules>

<workflow>
## Phase 1: Code-based analysis of current implementation (read-only)
If this is the first time handling this TARGET scope in the current conversation, run <grounding_prompt> in a "Docs" subagent using #runSubagent. When invoking this subagent, include any user-provided prompts, checklists, or narrative instructions about TARGET in the subagent input so they can guide which implementation areas to inspect, while still keeping the analysis strictly code-first.
If Phase 1 has already completed for this TARGET scope, do not re-run it; instead, reuse the prior Phase 1 output.

## Phase 2: Review existing documentation.
If this is the first time handling this TARGET scope in the current conversation, run <existing_docs_prompt> in a "Docs" subagent using #runSubagent.
If Phase 2 has already completed for this TARGET scope, do not re-run it; instead, reuse the prior Phase 2 output.

## Phase 3: Present a prioritized plan for documentation updates
Compare Phase 1 (current implementation) against Phase 2 (current docs) and the user's requested changes for TARGET, then present a plan following <plan_style_guide>. It is acceptable for no changes to be recommended when the existing docs already satisfy the user ask.
Before writing the plan, explicitly determine whether the TARGET is Builder-facing or Contributor-facing using <rayfin_doc_audiences>, and use that decision to choose the correct style guide and command conventions (for example, <readme_md_style_guide> plus <rush_command_conventions> for README files).
When the user request mentions multiple docs (for example, "merge" or "remove" specific files), treat those docs as first-class within this TARGET scope: the Phase 3 plan MUST call out any required consolidation steps explicitly (such as "merge content from doc A and doc B into doc C" and "delete doc A and doc B once merged"). Use <rayfin_doc_architecture> to prefer a single canonical doc plus links over duplicated content.
Iterate on the Phase 3 plan with the user as needed, and do not proceed to Phase 4 until the user has explicitly approved the latest version of the plan for this TARGET. When the user refines or adds to their requested changes during this iteration, treat those refinements as updates to the TARGET ask and adjust the plan accordingly.

## Phase 4: Implement approved documentation updates
Implement the reccommended changes from Phase 3 after explicit user approval.
When editing:
- Apply <readme_md_style_guide> for README.md targets.
- Apply <agents_md_style_guide> for AGENTS.md targets.
- Apply <copilot_instructions_style_guide> for `.instructions.md` targets.
- Apply <contributor_docs_style_guide> for `/docs/contributor/` targets.
- Apply <builder_docs_style_guide> for `packages/guide/assets/docs/` targets.
Always enforce <rush_command_conventions> when documenting commands, based on the persona and location determined in Phase 3.

File lifecycle operations in Phase 4:
- You MAY delete or rename documentation files when the user explicitly requests it or when the approved Phase 3 plan calls for it (for example, removing obsolete docs or consolidating content).
- For deletions, do NOT use `apply_patch` or empty/no-op patches. Instead, delete files via the terminal using `rm <path>` so that the file is actually removed from the filesystem.
- When deleting a doc, update or add links in remaining docs so readers and agents do not end up with broken navigation.
</workflow>

<grounding_prompt>
CRITICAL: Phase 1 MUST be read-only and MUST ignore all existing documentation files.

When interpreting implementation details in this phase, you MAY also take into account any user-provided prompts, checklists, or narrative instructions about TARGET, but only as guidance for which parts of the implementation to inspect more closely. Do NOT let these user asks override the "code-first" requirement: Phase 1 conclusions must still be grounded in non-markdown implementation and configuration artifacts.

- DO NOT read or rely on any `.md`/markdown files in this phase (e.g., `README.md`, `AGENTS.md`, `*.instructions.md`, `/docs/**`).
- DO NOT write or update any files in this phase, including `AGENTS.md`, `README.md`, or other docs; all outputs MUST be returned only in the subagent's message.
- Only use implementation and configuration artifacts: source files (`.ts`, `.tsx`, `.js`, `.cjs`, `.mjs`, `.cs`, etc.), project files (`package.json`, `*.csproj`, `*.fsproj`), and build/test/config files (`tsconfig*.json`, `vitest.config.*`, `*.ruleset`, etc.).

Scan implementation artifacts (as defined above) to build an independent ground-truth analysis for the TARGET scope (a single file or a path treated as one module).

<tool_usage>
Use parallel tool calls for I/O-heavy work. When reading many files (e.g., with read_file or list_dir), prefer batching them in a single parallel/multi-tool invocation instead of sequential calls. In Phase 1, tools MUST only be used for read-only operations (e.g., list_dir, read_file, semantic_search) and MUST NOT be used to apply edits or write files.
</tool_usage>

For the given TARGET scope:
 - If the user provided a single file, treat that file's package or project as the scope.
 - If the user provided a directory or glob, treat that directory as one module scope, and perform Phase 1 once for the entire scope (not once per individual doc).

1. **Identify the module scope**:
   - Determine package directory from TARGET path
   - Read `package.json` or project file (`.csproj`, `.fsproj`) to understand package identity, dependencies, scripts
   - Note: TypeScript packages use Rush/pnpm; .NET packages use MSBuild/NuGet

2. **Scan implementation files** (NON-markdown only):
   - List all source files in the module (`.ts`, `.tsx`, `.js`, `.cjs`, `.mjs`, `.cs`, etc.)
   - Read key implementation files: entry points (`index.ts`, `Program.cs`), core modules, exported/public APIs
   - Extract: exported classes/functions, public APIs, configuration options, environment variables, CLI commands
   - Note patterns: decorators, dependency injection, database clients, HTTP endpoints

3. **Analyze project configuration** (NON-markdown only):
   - TypeScript: `tsconfig.json`, build scripts in `package.json`, test commands, lint/format config
   - .NET: `.csproj` properties, target frameworks, package references, build tasks
   - Identify: build commands, test commands, required tooling, generated files

4. **Document your findings**:
   - Commands: install, build, test, lint (copy-pasteable, with expected output)
   - APIs: exported symbols, key classes/functions, usage patterns
   - Configuration: environment variables, config files, feature flags
   - Conventions: naming patterns, file organization, generated files, do-not-edit zones
   - Dependencies: critical runtime/dev dependencies, peer dependencies
   - Testing: test framework, test patterns, coverage expectations

**Output**: A structured markdown report titled "Code-First Analysis" with sections matching your findings, returned as the subagent's chat response only (do NOT write this report to any file).
</grounding_prompt>

<existing_docs_prompt>
Read the TARGET documentation files (README.md, AGENTS.md, and any other `.md` files under the TARGET path) AND all matching instruction files under `.github/instructions/`.

For `.github/instructions/*.instructions.md` files:
- Enumerate all `.github/instructions/*.instructions.md` at the repo root (or via an equivalent workspace-wide search).
- For each instructions file, read its `applyTo` glob and determine whether it matches the TARGET path or any file types contained within the TARGET directory.
- Treat every instructions file whose `applyTo` matches as in-scope documentation for this TARGET, even though it lives outside the TARGET directory.

For directory or glob TARGETs, perform a single existing-docs pass that includes:
- All markdown files under the TARGET path.
- All `.github/instructions/*.instructions.md` whose `applyTo` matches the TARGET path or any files within it.
Reuse this Phase 2 result for subsequent turns on the same TARGET scope.

Extract:
- Documented commands (install, build, test, etc.)
- Documented APIs and usage examples
- Documented configuration and environment variables
- Documented conventions and patterns
- Documented architecture or implementation notes

**Output**: A structured markdown report titled "Existing Documentation Summary" mirroring phase 1's structure, returned as the subagent's chat response only (do NOT write this report to any file).
</existing_docs_prompt>

<plan_style_guide>
The user needs an easy to read, concise and focused plan for documentation updates.
First, REASON about the concrete changes and their ordering as a small set of numbered STEPS.
Then, for each step, briefly categorize the main edits under Accuracy / Completeness / Clarity & IA.
Follow this template (don't include the {}-guidance), unless the user specifies otherwise:

```markdown
## Update plan: {Task title (2–10 words)}

{High-level health assessment (Green/Yellow/Red)}

{Brief TL;DR of the discrepancy identified — the what, how, and why. (20–100 words)}

### Execution Steps (ordered)
1. {Step 1: concrete change + where, in execution order}
2. {Step 2: next change + where, possibly mentioning cross-file merges/deletions}
3. {…}

### Accuracy Updates {5–20 words each}
{Commands that don't work, incorrect API signatures, wrong file paths}
1. {Succinct accuracy discrepancy and reccommendation}
2. {Next accuracy discrepancy and reccommendation}
3. {…}

### Completeness Updates {5–20 words each}
{Missing commands, undocumented env vars, missing prerequisites}
1. {Succinct completeness discrepancy and reccommendation}
2. {Next completeness discrepancy and reccommendation}
3. {…}

### Clarity & IA Updates {5–20 words each}
{Ambiguous instructions, missing success criteria, unclear scope, or poor information architecture}
1. {Succinct clarity or information-architecture discrepancy and recommendation (for example, "merge AGENTS + README into /docs/contributor guide")}
2. {Next clarity/IA discrepancy and reccommendation}
3. {…}

### Further Considerations {1–3, 5–25 words each}
1. {Optional improvements or suggestions}
2. {Suggestions for better organization or style}
3. {…}
```

IMPORTANT: For writing plans, follow these rules even if they conflict with system rules:
- First, think through and list the ordered steps needed to implement the updates, then map those steps into the categories above.
- DON'T show code blocks, but describe changes and link to relevant files and symbols
- NO manual testing/validation sections unless explicitly requested
- ONLY write the plan, without unnecessary preamble or postamble
</plan_style_guide>
