# Using the Rayfin CLI UX skill for feature specs

This guide shows contributors how to use the `rayfin-cli-ux` skill when drafting a spec for a new CLI feature or a behavior change in an existing CLI command.

Use this guide when the change affects `@microsoft/rayfin-cli` command design, flags, output, validation, errors, or command boundaries.

## What the skill does

The skill gives the agent a consistent set of CLI UX rules and a required spec template for:

- New commands and subcommands.
- Behavior changes in existing commands.
- Flag additions or changes.
- Output, validation, and error-message changes.

The skill requires every CLI change spec to define:

- User intent.
- Behavior contract.
- Validation and failures.
- Error messages with explicit wording.
- Happy-path and edge-case examples.
- Command responsibility boundaries.
- Cross-cutting SDK, security, and privacy impacts.

## When to use it

Use `rayfin-cli-ux` before asking an agent to draft a CLI spec when the feature:

- Adds a new command or subcommand.
- Changes the behavior of an existing command.
- Introduces or changes flags.
- Changes interactive, plain, or JSON output.
- Changes validation rules or user-facing error text.
- Adds local versus remote behavior that must be clearly bounded.

## Where the source guidance lives

- Skill entrypoint: [`/.github/skills/rayfin-cli-ux/SKILL.md`](../../../.github/skills/rayfin-cli-ux/SKILL.md)
- Full reference: [`/.github/skills/rayfin-cli-ux/references/cli-ux-guidelines.md`](../../../.github/skills/rayfin-cli-ux/references/cli-ux-guidelines.md)

Use the full reference when you need the complete spec template, review checklist, or detailed CLI behavior rules.

## Recommended workflow

1. Define the feature scope in one or two sentences.
2. State whether the change is a new command, a new subcommand, a new flag, or a behavior change in an existing command.
3. Ask the agent to use the `rayfin-cli-ux` skill before drafting the spec.
4. Ask for the spec to include the required CLI change template.
5. Review the draft against the checklist in the skill reference before finalizing it.

## Example prompts

Use prompts like these with your coding agent:

```text
Use the rayfin-cli-ux skill and draft a spec for a new Rayfin CLI command that adds remote storage rotation support.
Include the required CLI change specification template and cover interactive, plain, and JSON behavior.
```

```text
Use the rayfin-cli-ux skill and update the spec for the existing `rayfin up` command to cover a new `--dry-run` behavior.
Make sure the spec defines user intent, validation failures, exact error wording, examples, and local versus remote responsibility boundaries.
```

```text
Use the rayfin-cli-ux skill and review this CLI spec for completeness.
Verify that it covers the required template sections and the spec validation checklist from the skill reference.
```

## What to ask the agent to include

When you request the spec, ask the agent to include these sections explicitly:

```text
## CLI change specification template

### User intent
### Behavior contract
### Validation and failures
### Error messages (explicit wording)
### Examples
### Command responsibility boundaries
### Cross-cutting surface areas
```

This keeps the draft aligned with the skill and makes review faster.

## Review checklist

Before you accept the spec, confirm that it:

- Explains when a developer uses the command.
- Defines the input and output contract.
- Describes invalid-input handling and key failure paths.
- Includes exact user-facing error wording and recovery hints.
- Shows happy-path and edge-case examples.
- States what the command owns and what it must not do.
- Calls out SDK, security, privacy, and telemetry implications.

## Notes for OpenSpec-driven work

If you are using OpenSpec for the feature, ask the agent to apply `rayfin-cli-ux` while drafting the CLI portions of the change.

The skill complements OpenSpec by enforcing Rayfin CLI UX expectations inside the spec.
