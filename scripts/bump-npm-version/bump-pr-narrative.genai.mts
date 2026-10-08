/**
 * Optional GenAIScript hook for polishing the PR title/body produced by
 * scripts/bump-npm-version.ts.
 *
 * This is the ONLY LLM touchpoint in the entire version-bump flow, and it is
 * gated behind `--with-llm-narrative` (which itself requires `--pr`). The
 * deterministic script will continue to work fine without ever invoking this.
 *
 * Run via:
 *   npx --yes genaiscript run scripts/genai/bump-pr-narrative.genai.mts
 *
 * Inputs come from environment variables (set by bump-npm-version.ts):
 *   - BUMP_TITLE   — fallback PR title
 *   - BUMP_BODY    — fallback templated PR body (markdown)
 *   - BUMP_SUMMARY — JSON: { packages: [{ name, version }] }
 *
 * Output: stdout must contain a single JSON object: { title, body }.
 * If parsing fails, the deterministic script falls back to the templated body.
 */

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../node_modules/genaiscript/src/types/prompt_template.d.ts" />

const fallbackTitle = process.env.BUMP_TITLE ?? 'chore: bump packages';
const fallbackBody = process.env.BUMP_BODY ?? '';
const summaryRaw = process.env.BUMP_SUMMARY ?? '{"packages":[]}';

let summary: { packages: Array<{ name: string; version: string }> } = {
  packages: [],
};
try {
  summary = JSON.parse(summaryRaw);
} catch {
  // keep default
}

// genaiscript's `script()` registers metadata; `def()` exposes inputs to the
// model; `$\`...\`` is the prompt. This hook is intentionally tiny — it only
// rewrites the body, never the title.
script({
  title: 'bump-pr-narrative',
  description: 'Polish a Rayfin coordinated version-bump PR body.',
  model: 'small',
  system: ['system', 'system.output_json'],
  responseSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
});

def('FALLBACK_TITLE', fallbackTitle);
def('FALLBACK_BODY', fallbackBody);
def('PACKAGE_SUMMARY', JSON.stringify(summary, null, 2), { language: 'json' });

$`
You are polishing a coordinated NPM package version-bump PR for the Rayfin
monorepo. Return a JSON object with \`title\` and \`body\` fields. Do not
invent changes, version numbers, or issues that are not already present in
the inputs.

Rules:
- Keep \`title\` short, conventional-commit style. Prefer \`chore: bump packages to X.Y.Z\`
  when a single version is implied; otherwise keep the fallback title.
- Keep \`body\` in markdown. Preserve the \`Closes #N\` line from the fallback
  body verbatim if it exists. Preserve the package table from the fallback body.
- Add a one-paragraph summary at the top describing this as a coordinated
  release. Do NOT speculate about which features changed.
- Never include \`[skip ci]\`, \`[ci skip]\`, \`[no ci]\`, \`[skip actions]\`, or \`***NO_CI***\`.

Output ONLY the JSON object — no fences, no extra prose.

FALLBACK_TITLE:
{{FALLBACK_TITLE}}

FALLBACK_BODY:
{{FALLBACK_BODY}}

PACKAGE_SUMMARY:
{{PACKAGE_SUMMARY}}
`;
