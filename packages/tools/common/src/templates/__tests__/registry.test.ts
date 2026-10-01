import { randomUUID } from 'crypto';
import { writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadRegistries } from '../registry/loader';

describe('loadRegistries', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `registry-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads a valid registry file', async () => {
    const content = `
registries:
  - name: contoso-templates
    displayName: Contoso Templates
    description: Templates from the Contoso team
    url: https://github.com/contoso/templates
    templateName: starter
    default: true
    firstClass: true
  - name: fabrikam-templates
    displayName: Fabrikam Templates
    url: https://github.com/fabrikam/templates
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(2);
    expect(result.registries[0]).toMatchObject({
      name: 'contoso-templates',
      displayName: 'Contoso Templates',
      description: 'Templates from the Contoso team',
      url: 'https://github.com/contoso/templates',
      templateName: 'starter',
      default: true,
      firstClass: true,
    });
    expect(result.registries[1]).toMatchObject({
      name: 'fabrikam-templates',
      displayName: 'Fabrikam Templates',
      url: 'https://github.com/fabrikam/templates',
    });
    expect(result.warnings).toEqual([]);
  });

  it('returns empty registry for missing file', async () => {
    const result = await loadRegistries(join(testDir, 'nonexistent.yml'));
    expect(result.registries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('returns empty registry for empty registries array', async () => {
    await writeFile(join(testDir, 'registries.yml'), 'registries: []\n');
    const result = await loadRegistries(join(testDir, 'registries.yml'));
    expect(result.registries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('skips malformed entries with warnings', async () => {
    const content = `
registries:
  - name: valid-entry
    url: https://github.com/org/repo
  - name: missing-url
  - url: https://github.com/org/no-name
  - invalid-string
  - name: also-valid
    url: https://github.com/org/another
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(2);
    expect(result.registries[0].name).toBe('valid-entry');
    expect(result.registries[1].name).toBe('also-valid');
    // 3 invalid entries produce warnings
    expect(result.warnings.length).toBe(3);
  });

  it('returns empty registry for non-object YAML', async () => {
    await writeFile(join(testDir, 'registries.yml'), 'just a string\n');
    const result = await loadRegistries(join(testDir, 'registries.yml'));
    expect(result.registries).toEqual([]);
  });

  it('returns empty registry when registries key is not an array', async () => {
    await writeFile(
      join(testDir, 'registries.yml'),
      'registries: not-an-array\n'
    );
    const result = await loadRegistries(join(testDir, 'registries.yml'));
    expect(result.registries).toEqual([]);
  });

  it('uses name as displayName fallback', async () => {
    const content = `
registries:
  - name: my-registry
    url: https://example.com/templates
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries[0].displayName).toBe('my-registry');
  });

  it('filters out entries with non-string name', async () => {
    const content = `
registries:
  - name: 123
    url: https://example.com/templates
  - name: valid
    url: https://example.com/other
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(1);
    expect(result.registries[0].name).toBe('valid');
  });

  it('preserves bare floating-semver tag refs as strings (no YAML coercion)', async () => {
    // Unquoted refs that look like semver tags must round-trip as strings -
    // the `yaml` package (YAML 1.2) does not coerce `v`-prefixed tokens to
    // numbers or YAML 1.1 weirdness (e.g. the "Norway problem"). One bare
    // case plus one with build-metadata (`+`) is enough; iterating every
    // semver shape adds no signal because the parser doesn't branch on it.
    const content = `
registries:
  - name: floating-major
    url: https://example.com/templates
    ref: v1
  - name: build-meta
    url: https://example.com/templates
    ref: v1.0.0-rc.1+build.5
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.warnings).toEqual([]);
    expect(result.registries).toHaveLength(2);
    expect(result.registries[0].ref).toBe('v1');
    expect(result.registries[1].ref).toBe('v1.0.0-rc.1+build.5');
  });

  it('loads stable, alpha, and beta refs', async () => {
    const content = `
registries:
  - name: channel-pinned
    url: https://example.com/templates
    ref: v1
    alphaRef: v2-alpha
    betaRef: v2-beta
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.warnings).toEqual([]);
    expect(result.registries[0]).toMatchObject({
      ref: 'v1',
      alphaRef: 'v2-alpha',
      betaRef: 'v2-beta',
    });
  });

  it('warns and drops non-string channel refs independently', async () => {
    const content = `
registries:
  - name: channel-pinned
    url: https://example.com/templates
    ref: v1
    alphaRef: 2
    betaRef: "2.0"
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries[0]).toMatchObject({
      ref: 'v1',
      betaRef: '2.0',
    });
    expect(result.registries[0].alphaRef).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("'alphaRef' must be a string");
  });

  it('warns and drops number-coerced refs (e.g. unquoted `1.0`)', async () => {
    // Unquoted `1.0` parses as a JS number `1` and unquoted `1` parses as
    // integer `1`. Without the `v` prefix or quoting, YAML strips the type.
    // The loader rejects non-string `ref` values with a warning and loads the
    // entry without a pin, surfacing the footgun at the parse boundary instead
    // of silently scaffolding the default branch.
    const content = `
registries:
  - name: number-coerced-major
    url: https://example.com/templates
    ref: 1
  - name: number-coerced-minor
    url: https://example.com/templates
    ref: 1.0
  - name: quoted-survives
    url: https://example.com/templates
    ref: "1.0"
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(3);
    // Unquoted numeric refs are dropped to undefined and produce a warning.
    expect(result.registries[0].ref).toBeUndefined();
    expect(result.registries[1].ref).toBeUndefined();
    // Quoted form survives as a string.
    expect(result.registries[2].ref).toBe('1.0');

    // Exactly one warning per coerced entry; quoted entry produces none.
    const refWarnings = result.warnings.filter((w) => w.includes("'ref'"));
    expect(refWarnings).toHaveLength(2);
    expect(refWarnings[0]).toContain('number-coerced-major');
    expect(refWarnings[0]).toContain('must be a string');
    expect(refWarnings[0]).toContain('Quote the value');
    expect(refWarnings[1]).toContain('number-coerced-minor');
  });

  it('filters out entries with non-string url', async () => {
    const content = `
registries:
  - name: bad-url
    url: 42
  - name: good-url
    url: https://example.com/templates
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(1);
    expect(result.registries[0].name).toBe('good-url');
  });

  it('filters out entries with empty string name or url', async () => {
    const content = `
registries:
  - name: ""
    url: https://example.com/templates
  - name: empty-url
    url: ""
  - name: valid
    url: https://example.com/other
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(1);
    expect(result.registries[0].name).toBe('valid');
  });

  it('filters out entries with non-git URLs', async () => {
    const content = `
registries:
  - name: http-only
    url: http://example.com/templates
  - name: bare-path
    url: /local/path/to/templates
  - name: valid-https
    url: https://github.com/org/templates
  - name: valid-ssh
    url: git@github.com:org/templates.git
`;
    await writeFile(join(testDir, 'registries.yml'), content);
    const result = await loadRegistries(join(testDir, 'registries.yml'));

    expect(result.registries).toHaveLength(2);
    expect(result.registries[0].name).toBe('valid-https');
    expect(result.registries[1].name).toBe('valid-ssh');
  });
});
