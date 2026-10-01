/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { applyTemplateFeatures } from '@microsoft/rayfin-tools-common/_internal/templates';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTemplateFilter } from '../template-ignore.mjs';

const tempRoot =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Temp')
    : tmpdir();

/**
 * Run through `createTemplateFilter` rather than `isExcluded` directly. The
 * path-based rules only fire if the bundler hands the filter a relative path,
 * so asserting the matcher alone would still pass with that wiring removed.
 *
 * Lives beside the build scripts rather than under `src/`, because the package
 * `tsconfig.json` compiles `src` for a DOM/WebWorker target with no Node types.
 * Same split the CLI package uses for its own script tests.
 */
describe('bundling the functions capability', () => {
  let root: string;
  let src: string;
  let dest: string;

  /** `rayfin functions` output, the kit seed it is named after, and app code. */
  const PLANTED = {
    'rayfin/functions/local.settings.json': '{"AzureWebJobsStorage":"secret"}',
    'rayfin/functions/deploymentdata.json': '{"resourceGroup":"chris-rg"}',
    'rayfin/functions/host.json': '{"version":"2.0"}',
    'packages/functions/local.settings.json':
      '{"AzureWebJobsStorage":"secret"}',
    'packages/functions/deploymentdata.json': '{"resourceGroup":"chris-rg"}',
    'packages/functions/host.json': '{"version":"2.0"}',
    '.agents/skills/functions-capability/kit/functions/local.settings.json':
      '{"Values":{}}',
    '.npmrc': '//registry.example.com/:_authToken=REDACTED',
    'packages/api/.npmrc': '//registry.example.com/:_authToken=REDACTED',
    'package.json': '{"name":"workspace-root"}',
    'packages/api/package.json': '{"name":"workspace-member"}',
    'src/index.ts': 'export {};',
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tempRoot, 'rayfin-vsix-tpl-')));
    src = join(root, 'sample');
    dest = join(root, 'bundled');

    for (const [file, contents] of Object.entries(PLANTED)) {
      const target = join(src, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }

    cpSync(src, dest, { recursive: true, filter: createTemplateFilter(src) });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['rayfin/functions/local.settings.json', 'connection strings and keys'],
    ['rayfin/functions/deploymentdata.json', 'deployment identifiers'],
    ['packages/functions/local.settings.json', 'connection strings and keys'],
    ['packages/functions/deploymentdata.json', 'deployment identifiers'],
  ])('leaves %s out of the vsix (%s)', (file) => {
    expect(existsSync(join(dest, file))).toBe(false);
  });

  it('keeps the kit seed that shares a filename with the excluded state', () => {
    // The whole reason the rule is a path. Excluding by basename would drop
    // this too, and the scaffolded app could no longer run functions at all.
    expect(
      existsSync(
        join(
          dest,
          '.agents/skills/functions-capability/kit/functions/local.settings.json'
        )
      )
    ).toBe(true);
  });

  it('keeps the rest of the generated functions app', () => {
    // Two files are excluded, not the directory they sit in.
    expect(existsSync(join(dest, 'rayfin/functions/host.json'))).toBe(true);
    expect(existsSync(join(dest, 'packages/functions/host.json'))).toBe(true);
    expect(existsSync(join(dest, 'src/index.ts'))).toBe(true);
  });

  it('drops only the rewritten root manifest and keeps workspace manifests', () => {
    expect(existsSync(join(dest, 'package.json'))).toBe(false);
    expect(existsSync(join(dest, 'packages/api/package.json'))).toBe(true);
  });

  it.each(['.npmrc', 'packages/api/.npmrc'])(
    'leaves %s out of the vsix',
    (file) => {
      // Registry credentials once anyone has authenticated against a private
      // feed, and gitignored, so it never shows up in `git status` first.
      expect(existsSync(join(dest, file))).toBe(false);
    }
  );

  it('materializes the default feature state before the VSIX ships a template', () => {
    writeFileSync(
      join(dest, 'package.json'),
      JSON.stringify({
        name: 'example',
        template: { name: 'example', features: ['optional-view'] },
      })
    );
    const featureRoot = join(
      dest,
      '.template-features',
      'optional-view',
      'src'
    );
    mkdirSync(featureRoot, { recursive: true });
    writeFileSync(
      join(featureRoot, 'extra.ts'),
      'export const optional = true;'
    );
    applyTemplateFeatures(dest, new Set());
    expect(existsSync(join(dest, '.template-features'))).toBe(false);
    expect(existsSync(join(dest, 'src', 'extra.ts'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).template
        .features
    ).toBeUndefined();
  });
});
