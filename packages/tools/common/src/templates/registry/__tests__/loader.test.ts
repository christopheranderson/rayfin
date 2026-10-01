import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadRegistries } from '../loader';

describe('loadRegistries', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `loader-test-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    filePath = join(dir, 'template-registries.yml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses string ref, alphaRef, and betaRef with no malformed fields', async () => {
    await writeFile(
      filePath,
      `registries:
  - name: pinned
    url: https://github.com/org/templates
    ref: v1
    alphaRef: v1-alpha
    betaRef: v1-beta
`
    );

    const result = await loadRegistries(filePath);
    const entry = result.registries.find((e) => e.name === 'pinned');

    expect(entry).toBeDefined();
    expect(entry!.ref).toBe('v1');
    expect(entry!.alphaRef).toBe('v1-alpha');
    expect(entry!.betaRef).toBe('v1-beta');
    expect(entry!.malformedRefFields).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['numeric', 'alphaRef: 123'],
    ['null', 'alphaRef: null'],
    ['boolean', 'alphaRef: true'],
  ])(
    'flags a %s alphaRef as malformed instead of treating it as absent',
    async (_label, yamlLine) => {
      await writeFile(
        filePath,
        `registries:
  - name: entry
    url: https://github.com/org/templates
    ref: v1
    ${yamlLine}
`
      );

      const result = await loadRegistries(filePath);
      const entry = result.registries.find((e) => e.name === 'entry');

      expect(entry).toBeDefined();
      // The malformed value itself is dropped (stays string | undefined)...
      expect(entry!.alphaRef).toBeUndefined();
      // ...but the loader must record that a channel override was
      // configured-but-malformed, not simply omitted, so protected-entry
      // validation can tell the two cases apart.
      expect(entry!.malformedRefFields).toEqual(['alphaRef']);
      expect(result.warnings).toEqual([
        expect.stringContaining("'alphaRef' must be a string"),
      ]);
    }
  );

  it.each([
    ['numeric', 'betaRef: 456'],
    ['null', 'betaRef: null'],
    ['boolean', 'betaRef: false'],
  ])(
    'flags a %s betaRef as malformed even when only the stable/alpha channel is selected',
    async (_label, yamlLine) => {
      // This entry never selects the beta channel at resolution time, but a
      // malformed betaRef was still configured on it - validation must see
      // that regardless of which channel ends up chosen.
      await writeFile(
        filePath,
        `registries:
  - name: entry
    url: https://github.com/org/templates
    ref: v1
    alphaRef: v1-alpha
    ${yamlLine}
`
      );

      const result = await loadRegistries(filePath);
      const entry = result.registries.find((e) => e.name === 'entry');

      expect(entry).toBeDefined();
      expect(entry!.betaRef).toBeUndefined();
      expect(entry!.malformedRefFields).toEqual(['betaRef']);
    }
  );

  it('records every malformed ref field on the same entry', async () => {
    await writeFile(
      filePath,
      `registries:
  - name: entry
    url: https://github.com/org/templates
    ref: 42
    alphaRef: null
    betaRef: true
`
    );

    const result = await loadRegistries(filePath);
    const entry = result.registries.find((e) => e.name === 'entry');

    expect(entry).toBeDefined();
    expect(entry!.ref).toBeUndefined();
    expect(entry!.alphaRef).toBeUndefined();
    expect(entry!.betaRef).toBeUndefined();
    expect(entry!.malformedRefFields).toEqual(['ref', 'alphaRef', 'betaRef']);
  });

  it('parses an explicitly empty-string alphaRef/betaRef as a string, not malformed', async () => {
    // Empty string is a valid (if unusual) string value - it is not a type
    // error at the loader level. Guarding against it turning into an
    // unpinned dispatch is `registryRefForCliVersion`'s job, not the
    // loader's; see template-registry.test.ts.
    await writeFile(
      filePath,
      `registries:
  - name: entry
    url: https://github.com/org/templates
    ref: v1
    alphaRef: ""
    betaRef: ""
`
    );

    const result = await loadRegistries(filePath);
    const entry = result.registries.find((e) => e.name === 'entry');

    expect(entry).toBeDefined();
    expect(entry!.alphaRef).toBe('');
    expect(entry!.betaRef).toBe('');
    expect(entry!.malformedRefFields).toBeUndefined();
  });
});
