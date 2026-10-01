/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- build script, deliberately untyped JavaScript.
import { isExcluded } from '../../scripts/template-ignore.mjs';

/**
 * The bundled templates are copied out of `samples/`, which are working Rush
 * projects people run locally, and the vsix is packaged from a developer's
 * working tree rather than in CI. Everything asserted here is gitignored, so it
 * is invisible in `git status` and a regression would ship silently.
 */
describe('bundled template exclusions', () => {
  it.each([
    ['.deployments.json', 'workspace and deployment state from `rayfin up`'],
    ['.rayfin-copilot.json', 'local Copilot plugin state'],
    ['.env', 'secrets'],
    ['.env.local', 'secrets'],
    ['.env.fabric-example', 'secrets'],
    ['.temp', 'scratch state from `rayfin dev`'],
    ['.tmp', 'scratch state'],
    ['.cache', 'build cache'],
    ['.vite', 'Vite dependency cache'],
    ['tsconfig.tsbuildinfo', 'incremental build state'],
    ['node_modules', 'installed dependencies'],
    ['dist', 'build output'],
    ['.npmrc', 'registry credentials'],
    ['package-lock.json', 'a lock that would defeat the caret ranges'],
  ])('excludes %s (%s)', (name) => {
    expect(isExcluded(name)).toBe(true);
  });

  it('excludes developer state at any depth, not just the template root', () => {
    // `rayfin up` writes into `rayfin/`, never the template root.
    expect(isExcluded('.deployments.json', false)).toBe(true);
    expect(isExcluded('.temp', false)).toBe(true);
    expect(isExcluded('.env.local', false)).toBe(true);
  });

  it("excludes Rush's config/ at the root only", () => {
    expect(isExcluded('config', true)).toBe(true);
    // `src/config` is ordinary app code. Dropping it silently breaks the
    // scaffolded app rather than merely leaking something.
    expect(isExcluded('config', false)).toBe(false);
  });

  it.each(['src', 'package.json', 'README.md', 'vite.config.ts', 'rayfin'])(
    'keeps %s',
    (name) => {
      expect(isExcluded(name, true)).toBe(false);
    }
  );

  it('matches on the exact basename, so near-misses are not assumed covered', () => {
    // Guards the bug this list shipped with: it carried `.tsbuildinfo`, which
    // never matched the `tsconfig.tsbuildinfo` TypeScript actually writes.
    expect(isExcluded('.tsbuildinfo')).toBe(false);
    expect(isExcluded('tsconfig.tsbuildinfo')).toBe(true);
  });
});
