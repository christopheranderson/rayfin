import { randomUUID } from 'crypto';
import { writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  discoverRegistryEntries,
  hasPinnedBundledRegistryRefs,
  isPinnedBundledRegistryRef,
  registryRefForCliVersion,
} from '../template-registry';

// Mock homedir to control the global registry tier
let mockHomeDir: string;
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, homedir: () => mockHomeDir };
});

describe('discoverRegistryEntries', () => {
  let projectDir: string;

  beforeEach(async () => {
    const id = randomUUID();
    projectDir = join(tmpdir(), `registry-project-${id}`);
    mockHomeDir = join(tmpdir(), `registry-global-${id}`);
    await mkdir(projectDir, { recursive: true });
    await mkdir(mockHomeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(mockHomeDir, { recursive: true, force: true });
  });

  it('returns entries from a project-local registry file', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: team-templates
    displayName: Team Templates
    url: https://github.com/my-org/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const teamEntry = result.entries.find((e) => e.name === 'team-templates');

    expect(teamEntry).toBeDefined();
    expect(teamEntry!.url).toBe('https://github.com/my-org/templates');
    expect(teamEntry!.displayName).toBe('Team Templates');
  });

  it('returns entries from a global registry file', async () => {
    await mkdir(join(mockHomeDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(mockHomeDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: global-templates
    displayName: Global Templates
    url: https://github.com/global-org/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const globalEntry = result.entries.find(
      (e) => e.name === 'global-templates'
    );

    expect(globalEntry).toBeDefined();
    expect(globalEntry!.url).toBe('https://github.com/global-org/templates');
  });

  it('merges project and global registries', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: project-only
    url: https://github.com/project/templates
`
    );

    await mkdir(join(mockHomeDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(mockHomeDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: global-only
    url: https://github.com/global/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const names = result.entries.map((e) => e.name);

    expect(names).toContain('project-only');
    expect(names).toContain('global-only');
  });

  it('warns on name conflict between global and project', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: shared
    displayName: Project Version
    url: https://github.com/project/templates
`
    );

    await mkdir(join(mockHomeDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(mockHomeDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: shared
    displayName: Global Version
    url: https://github.com/global/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);

    // First-seen wins (global is loaded before project in tier order)
    const sharedEntries = result.entries.filter((e) => e.name === 'shared');
    expect(sharedEntries).toHaveLength(1);
    // Second definition produces a warning
    expect(result.warnings.some((w) => w.includes("'shared'"))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Rename one'))).toBe(true);
  });

  it('returns bundled registry entries when no user registries exist', async () => {
    const result = await discoverRegistryEntries(projectDir, '1.2.3');
    const dataappEntry = result.entries.find((e) => e.name === 'dataapp');

    expect(dataappEntry).toMatchObject({
      displayName: 'Data App',
      description: 'Build data analytics app based on your data in Fabric',
      url: 'https://github.com/microsoft/fabric-apps-analytic-templates',
      ref: 'v1',
      alphaRef: 'alpha',
      betaRef: 'beta',
      templateName: 'Data App',
      default: true,
      firstClass: true,
      registrySource: 'bundled',
    });
    expect(result.warnings).toEqual([]);
  });

  it('warns on duplicate names within a single file', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: dupe
    displayName: First
    url: https://github.com/first/templates
  - name: dupe
    displayName: Second
    url: https://github.com/second/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const dupeEntries = result.entries.filter((e) => e.name === 'dupe');

    expect(dupeEntries).toHaveLength(1);
    expect(dupeEntries[0].displayName).toBe('First');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('filters out entries with non-git URLs and reports warnings', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: valid
    url: https://github.com/org/repo
  - name: http-only
    url: http://example.com/repo
  - name: bare-path
    url: /local/path
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const projectEntries = result.entries.filter(
      (e) => e.registrySource !== 'bundled'
    );

    expect(projectEntries).toHaveLength(1);
    expect(projectEntries[0].name).toBe('valid');
    // Dropped entries produce warnings
    expect(result.warnings.length).toBe(2);
  });

  it('handles malformed project registry gracefully', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      'not valid yaml: [[[unterminated'
    );

    await expect(discoverRegistryEntries(projectDir)).rejects.toThrow();
  });

  it('parses ref, path, and default fields', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: pinned
    url: https://github.com/org/templates
    ref: v1.2.0
    path: catalogs/official
    default: true
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const entry = result.entries.find((e) => e.name === 'pinned');

    expect(entry).toBeDefined();
    expect(entry!.ref).toBe('v1.2.0');
    expect(entry!.path).toBe('catalogs/official');
    // default is ignored in non-bundled tiers
    expect(entry!.default).toBe(false);
  });

  it.each([
    ['1.2.3', 'v1'],
    ['1.2.3+build.5', 'v1'],
    ['1.2.3-alpha', 'v2-alpha'],
    ['1.2.3-alpha.17', 'v2-alpha'],
    ['1.2.3-beta', 'v2-beta'],
    ['1.2.3-beta.4+build.5', 'v2-beta'],
    ['1.2.3-rc.1', 'v1'],
    ['Unknown', 'v1'],
  ])('selects the ref for CLI version %s', (cliVersion, expected) => {
    expect(
      registryRefForCliVersion(
        { ref: 'v1', alphaRef: 'v2-alpha', betaRef: 'v2-beta' },
        cliVersion
      )
    ).toBe(expected);
  });

  it('falls back to the stable ref when a channel ref is absent', () => {
    expect(
      registryRefForCliVersion({ ref: 'v1', betaRef: 'v2-beta' }, '1.2.3-alpha')
    ).toBe('v1');
    expect(
      registryRefForCliVersion(
        { ref: 'v1', alphaRef: 'v2-alpha' },
        '1.2.3-beta'
      )
    ).toBe('v1');
  });

  it('falls back to the stable ref when a channel ref is an explicit empty string', () => {
    // `??` only treats `null`/`undefined` as absent, so an empty-string
    // override would otherwise pass through as-is here and produce an
    // unpinned clone (empty ref fragment) downstream instead of falling
    // back to `ref`.
    expect(
      registryRefForCliVersion(
        { ref: 'v1', alphaRef: '', betaRef: 'v2-beta' },
        '1.2.3-alpha'
      )
    ).toBe('v1');
    expect(
      registryRefForCliVersion(
        { ref: 'v1', alphaRef: 'v2-alpha', betaRef: '' },
        '1.2.3-beta'
      )
    ).toBe('v1');
  });

  it('never resolves to an unpinned (empty) ref for an entry with an empty-string channel override', async () => {
    // Loader-to-dispatch regression: a project-tier entry with an explicit
    // empty-string alphaRef must resolve through the same stable fallback
    // as an absent one, on the exact code path `init` uses to build the
    // clone URL fragment.
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: empty-alpha
    url: https://github.com/org/templates
    ref: v1
    alphaRef: ""
`
    );

    const alpha = await discoverRegistryEntries(projectDir, '1.2.3-alpha.1');
    const entry = alpha.entries.find((e) => e.name === 'empty-alpha');

    expect(entry).toBeDefined();
    expect(entry!.alphaRef).toBe('');
    const resolvedRef = registryRefForCliVersion(entry!, '1.2.3-alpha.1');
    expect(resolvedRef).toBe('v1');
    expect(resolvedRef).not.toBe('');
  });

  it('resolves registry refs using the CLI release channel', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: channel-pinned
    url: https://github.com/org/templates
    ref: v1
    alphaRef: v2-alpha
    betaRef: v2-beta
`
    );

    const alpha = await discoverRegistryEntries(projectDir, '1.2.3-alpha.1');
    const beta = await discoverRegistryEntries(projectDir, '1.2.3-beta.1');
    const stable = await discoverRegistryEntries(projectDir, '1.2.3');

    expect(alpha.entries.find((e) => e.name === 'channel-pinned')?.ref).toBe(
      'v2-alpha'
    );
    expect(beta.entries.find((e) => e.name === 'channel-pinned')?.ref).toBe(
      'v2-beta'
    );
    expect(stable.entries.find((e) => e.name === 'channel-pinned')?.ref).toBe(
      'v1'
    );
  });

  it.each([
    ['1.2.3', 'v1'],
    ['1.2.3-alpha.1', 'alpha'],
    ['1.2.3-beta.1', 'beta'],
  ])(
    'loads the bundled registry ref for CLI version %s',
    async (version, ref) => {
      const result = await discoverRegistryEntries(projectDir, version);
      const entry = result.entries.find((e) => e.name === 'dataapp');

      expect(entry).toBeDefined();
      expect(entry!.registrySource).toBe('bundled');
      expect(entry!.ref).toBe(ref);
      expect(entry!.alphaRef).toBe('alpha');
      expect(entry!.betaRef).toBe('beta');
      expect(entry!.default).toBe(true);
      expect(entry!.firstClass).toBe(true);
      expect(result.warnings).toEqual([]);
    }
  );

  it('bundled YAML pins data-app refs for every release channel', async () => {
    // Belt-and-suspenders: the loader assertion above relies on YAML parsing.
    // This test reads the raw file to guard against accidental quoting,
    // numeric coercion, or copy-paste regressions during YAML edits.
    const { readFile } = await import('fs/promises');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const yamlPath = resolve(
      here,
      '../../..',
      'assets',
      'template-registries.yml'
    );
    const yaml = await readFile(yamlPath, 'utf8');

    // Scope all assertions to the dataapp entry block specifically. The
    // bundled YAML may grow more entries over time; this test owns the
    // dataapp invariant and must not silently drift onto a sibling entry's
    // `ref:` line.
    const dataappBlock = yaml.match(
      /-\s*name:\s*dataapp[\s\S]*?(?=\n\s*-\s*name:|$)/
    );
    expect(
      dataappBlock,
      'dataapp entry must exist in bundled YAML'
    ).not.toBeNull();
    const dataappYaml = dataappBlock![0];

    // These bare values are the refs shipped for each CLI release channel.
    expect(dataappYaml).toMatch(/^\s*ref:\s*v1\s*$/m);
    expect(dataappYaml).toMatch(/^\s*alphaRef:\s*alpha\s*$/m);
    expect(dataappYaml).toMatch(/^\s*betaRef:\s*beta\s*$/m);

    // Must NOT contain a SHA pin or a branch ref for the bundled entry.
    expect(dataappYaml).not.toMatch(/^\s*ref:\s*[0-9a-fA-F]{40}\s*$/m);
    expect(dataappYaml).not.toMatch(
      /^\s*ref:\s*(main|master|develop|HEAD)\s*$/m
    );

    // The pin gate must accept every ref the dataapp entry ships with.
    // This ties the file content to the gate behavior so a YAML edit and
    // gate edit can never drift apart silently.
    for (const field of ['ref', 'alphaRef', 'betaRef']) {
      const refMatch = dataappYaml.match(
        new RegExp(`^\\s*${field}:\\s*(\\S+)\\s*$`, 'm')
      );
      expect(refMatch, `${field} must exist`).not.toBeNull();
      expect(isPinnedBundledRegistryRef(refMatch![1])).toBe(true);
    }
  });

  it('accepts SHAs and any tag-shaped ref, rejecting only obvious branch refs', () => {
    expect(
      isPinnedBundledRegistryRef('568c87fb262bde360a85e62e8f88700bab450478')
    ).toBe(true);
    expect(isPinnedBundledRegistryRef('refs/tags/v1.2.3')).toBe(true);
    expect(isPinnedBundledRegistryRef('refs/tags/releases/v1.2.3')).toBe(true);
    expect(isPinnedBundledRegistryRef('v1')).toBe(true);
    expect(isPinnedBundledRegistryRef('v1.2.3')).toBe(true);
    expect(isPinnedBundledRegistryRef('v1.0.0-beta.1')).toBe(true);
    expect(isPinnedBundledRegistryRef('v0.0.8-pre')).toBe(true);
    // Non-`v`-prefixed and date-shaped tags are accepted - the registry
    // author owns the tag-stability covenant.
    expect(isPinnedBundledRegistryRef('1.0.0')).toBe(true);
    expect(isPinnedBundledRegistryRef('2024.01.15')).toBe(true);
    expect(isPinnedBundledRegistryRef('release-2024-01')).toBe(true);
    expect(isPinnedBundledRegistryRef('lts')).toBe(true);
    expect(isPinnedBundledRegistryRef('stable')).toBe(true);

    // Empty / undefined.
    expect(isPinnedBundledRegistryRef(undefined)).toBe(false);
    expect(isPinnedBundledRegistryRef('')).toBe(false);

    // Known mutable branch sentinels (case-insensitive).
    expect(isPinnedBundledRegistryRef('HEAD')).toBe(false);
    expect(isPinnedBundledRegistryRef('head')).toBe(false);
    expect(isPinnedBundledRegistryRef('FETCH_HEAD')).toBe(false);
    expect(isPinnedBundledRegistryRef('main')).toBe(false);
    expect(isPinnedBundledRegistryRef('Main')).toBe(false);
    expect(isPinnedBundledRegistryRef('master')).toBe(false);
    expect(isPinnedBundledRegistryRef('develop')).toBe(false);
    expect(isPinnedBundledRegistryRef('trunk')).toBe(false);

    // Explicit branch form.
    expect(isPinnedBundledRegistryRef('refs/heads/main')).toBe(false);
    expect(isPinnedBundledRegistryRef('refs/heads/feature/x')).toBe(false);

    // Abbreviated SHAs are ambiguous - matches parseGitUrl rejection.
    expect(isPinnedBundledRegistryRef('568c87f')).toBe(false);
    expect(
      isPinnedBundledRegistryRef('568c87fb262bde360a85e62e8f88700bab45047')
    ).toBe(false);

    // Dash-prefixed refs could be parsed as a git flag - matches parseGitUrl.
    expect(isPinnedBundledRegistryRef('-rf')).toBe(false);
  });

  it('disambiguates pure-hex date-shaped refs (SHA-overlap edge cases)', () => {
    // The gate rejects pure-hex 7-39 char strings because they overlap with
    // abbreviated SHAs. Date-stamped tags must use a separator or a `v`
    // prefix to disambiguate. These edge cases exercise the SHA-overlap
    // rule specifically and would not be covered by the general
    // accept/reject test above (which uses purpose-shaped inputs).
    expect(isPinnedBundledRegistryRef('20240115')).toBe(false);
    expect(isPinnedBundledRegistryRef('20240115abc')).toBe(false);
    expect(isPinnedBundledRegistryRef('v20240115')).toBe(true);
    expect(isPinnedBundledRegistryRef('2024-01-15')).toBe(true);
  });

  it('rejects malformed-tail qualified tag refs (closes qualified-form bypass)', () => {
    // The qualified `refs/tags/<X>` form must not bypass the unqualified-form
    // guards. For every shape the gate rejects unqualified, it must also
    // reject the qualified form. This is the cross-source security invariant
    // from knowledge/personal/engineering.md ("Security validations must
    // propagate to all sibling source types") - and the exact gap Copilot
    // flagged on PR #1369 before this consolidation landed.
    const malformedTails = [
      '', // empty tail (refs/tags/)
      '-rf', // dash-prefixed (flag injection)
      '--upload-pack=evil',
      '568c87f', // 7-char abbreviated SHA
      'deadbeef', // 8-char abbreviated SHA
      '568c87fb262bde360a85e62e8f88700bab45047', // 39-char abbreviated SHA
    ];

    for (const tail of malformedTails) {
      expect(
        isPinnedBundledRegistryRef(`refs/tags/${tail}`),
        `expected refs/tags/${tail} rejected (qualified-form bypass)`
      ).toBe(false);
      // And the unqualified form is rejected too, for symmetry. If either
      // assertion drifts in the future, this test fails.
      if (tail !== '') {
        expect(
          isPinnedBundledRegistryRef(tail),
          `expected ${tail} rejected (unqualified-form sanity)`
        ).toBe(false);
      }
    }

    // Sanity: valid-tail qualified refs still pass through unchanged.
    expect(isPinnedBundledRegistryRef('refs/tags/v1')).toBe(true);
    expect(isPinnedBundledRegistryRef('refs/tags/v1.2.3')).toBe(true);
    expect(isPinnedBundledRegistryRef('refs/tags/release-2024-01')).toBe(true);
  });

  it('requires every configured ref on a protected entry to be pinned', () => {
    expect(
      hasPinnedBundledRegistryRefs({
        ref: 'v1',
        alphaRef: 'v2-alpha',
        betaRef: 'v2-beta',
      })
    ).toBe(true);
    expect(
      hasPinnedBundledRegistryRefs({
        ref: 'v1',
        alphaRef: 'main',
        betaRef: 'v2-beta',
      })
    ).toBe(false);
    expect(
      hasPinnedBundledRegistryRefs({
        ref: 'v1',
        alphaRef: 'v2-alpha',
        betaRef: 'refs/heads/beta',
      })
    ).toBe(false);
    expect(
      hasPinnedBundledRegistryRefs({
        alphaRef: 'v2-alpha',
        betaRef: 'v2-beta',
      })
    ).toBe(false);
  });

  it('rejects a protected entry with a malformed channel override, even on a channel that is not currently selected', () => {
    // The loader records a configured-but-malformed override via
    // `malformedRefFields` rather than silently coercing it to `undefined`.
    // `hasPinnedBundledRegistryRefs` doesn't know (or care) which channel a
    // caller is about to select - it must reject the entry outright, so a
    // malformed betaRef still fails validation even though only stable is
    // ever resolved in this test.
    expect(
      hasPinnedBundledRegistryRefs({
        ref: 'v1',
        alphaRef: 'v2-alpha',
        betaRef: undefined,
        malformedRefFields: ['betaRef'],
      })
    ).toBe(false);
    expect(
      hasPinnedBundledRegistryRefs({
        ref: 'v1',
        alphaRef: undefined,
        betaRef: 'v2-beta',
        malformedRefFields: ['alphaRef'],
      })
    ).toBe(false);
    expect(
      hasPinnedBundledRegistryRefs({
        ref: undefined,
        malformedRefFields: ['ref'],
      })
    ).toBe(false);
    // Sanity: an entry with no malformed fields and fully-pinned refs still
    // passes, so the new check doesn't over-reject.
    expect(
      hasPinnedBundledRegistryRefs({
        ref: 'v1',
        alphaRef: 'v2-alpha',
        betaRef: 'v2-beta',
        malformedRefFields: undefined,
      })
    ).toBe(true);
  });

  it('tags entries with registrySource', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: my-templates
    url: https://github.com/org/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const entry = result.entries.find((e) => e.name === 'my-templates');

    expect(entry).toBeDefined();
    expect(entry!.registrySource).toBeDefined();
    expect(entry!.registrySource).not.toBe('bundled');
  });

  it('surfaces loader warnings for invalid entries', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: valid
    url: https://github.com/org/repo
  - name: bad-scheme
    url: http://example.com/repo
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const projectEntries = result.entries.filter(
      (e) => e.registrySource !== 'bundled'
    );

    expect(projectEntries).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('bad-scheme'))).toBe(true);
  });

  it('warns on wrong YAML shape', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      'not_registries: true\n'
    );

    const result = await discoverRegistryEntries(projectDir);
    const projectEntries = result.entries.filter(
      (e) => e.registrySource !== 'bundled'
    );

    expect(projectEntries).toEqual([]);
    expect(result.warnings.some((w) => w.includes('registries'))).toBe(true);
  });

  it('protects bundled default entries from project-local override', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: dataapp
    displayName: Hijacked
    url: https://github.com/evil/templates
`
    );

    const result = await discoverRegistryEntries(projectDir);

    const entry = result.entries.find((e) => e.name === 'dataapp');
    expect(entry).toBeDefined();
    expect(entry!.url).toBe(
      'https://github.com/microsoft/fabric-apps-analytic-templates'
    );
    expect(entry!.default).toBe(true);
    expect(entry!.firstClass).toBe(true);
    expect(result.warnings.some((w) => w.includes('Protected entries'))).toBe(
      true
    );
  });

  it('sets default to false for non-bundled entries', async () => {
    await mkdir(join(projectDir, '.rayfin'), { recursive: true });
    await writeFile(
      join(projectDir, '.rayfin', 'template-registries.yml'),
      `registries:
  - name: user-entry
    url: https://github.com/user/templates
    default: true
    firstClass: true
`
    );

    const result = await discoverRegistryEntries(projectDir);
    const entry = result.entries.find((e) => e.name === 'user-entry');

    expect(entry).toBeDefined();
    // default/firstClass flags are ignored in non-bundled tiers
    expect(entry!.default).toBe(false);
    expect(entry!.firstClass).toBe(false);
  });
});
