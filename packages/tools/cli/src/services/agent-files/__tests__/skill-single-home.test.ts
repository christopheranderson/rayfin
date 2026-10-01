/**
 * The version-locked `rayfin` skill must have exactly one checked-in home.
 *
 * It used to have two: `packages/tools/cli/assets/agent-files/skills/rayfin/`,
 * written into a project by `rayfin init`, and a byte-identical copy inside the
 * distributed plugin. Nothing generated one from the other, so they drifted -
 * the plugin copy sat at version 0.2.0 while the CLI copy moved to 0.3.0 and
 * kept pointing at `node_modules/@microsoft/rayfin-mcp/assets/docs/guide/`, a
 * docs path the `rayfinDocs` per-package convention had already replaced. A
 * parity test held the two together until the duplication itself was removed.
 *
 * The distributed plugin in `plugin/` now ships only `rayfin-getting-started`,
 * whose whole job is to get an agent into a project and hand off. Everything
 * version-specific lives in the CLI asset, which is installed per project and
 * therefore matches the installed packages by construction.
 *
 * That split is the point, and this test guards it. Adding a `rayfin` skill
 * back into the plugin would reintroduce a globally-installed, version-unlocked
 * copy of precisely the content the split exists to keep version-locked, and it
 * would do so silently.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = resolve(here, '..', '..', '..', '..');
const repoRoot = resolve(cliPackageRoot, '..', '..', '..');

const BUNDLED = join(
  cliPackageRoot,
  'assets',
  'agent-files',
  'skills',
  'rayfin',
  'SKILL.md'
);
const PLUGIN_SKILLS = join(repoRoot, 'plugin', 'skills');

describe('rayfin skill homes', () => {
  it('the distributed plugin ships only the getting-started router skill', () => {
    const shipped = readdirSync(PLUGIN_SKILLS, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(shipped).toEqual(['rayfin-getting-started']);
  });

  it('the CLI-bundled copy is the only home for the version-locked skill', () => {
    const contents = readFileSync(BUNDLED, 'utf8');
    expect(contents).toContain('name: rayfin');
  });

  it('the bundled copy does not reference the pre-rayfinDocs corpus path', () => {
    const dead = 'rayfin-mcp/assets/docs';
    expect(readFileSync(BUNDLED, 'utf8')).not.toContain(dead);
  });
});
