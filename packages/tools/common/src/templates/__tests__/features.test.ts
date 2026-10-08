import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyTemplateFeatures } from '../engine/features.js';

const roots: string[] = [];
function fixture(features: unknown = ['sample-feature']): string {
  const root = mkdtempSync(join(tmpdir(), 'rayfin-template-features-'));
  roots.push(root);
  write(
    root,
    'package.json',
    JSON.stringify({ name: 'example', template: { name: 'example', features } })
  );
  write(root, 'src/entry.ts', 'export const value = "base";');
  write(
    root,
    '.template-features/sample-feature/src/entry.ts',
    'export { value } from "./optional";'
  );
  write(
    root,
    '.template-features/sample-feature/src/optional.ts',
    'export const value = "enabled";'
  );
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('template-owned features', () => {
  it.each([false, true])(
    'applies only selected overlays and leaves no feature payload (%s)',
    (enabled) => {
      const root = fixture();
      applyTemplateFeatures(root, new Set(enabled ? ['sample-feature'] : []));
      expect(existsSync(join(root, 'src/optional.ts'))).toBe(enabled);
      expect(readFileSync(join(root, 'src/entry.ts'), 'utf8')).toBe(
        enabled
          ? 'export { value } from "./optional";'
          : 'export const value = "base";'
      );
      expect(existsSync(join(root, '.template-features'))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).template
      ).toEqual({ name: 'example' });
    }
  );

  it('ignores flags not declared by the template', () => {
    const root = fixture();
    applyTemplateFeatures(root, new Set(['unrelated']));
    expect(existsSync(join(root, 'src/optional.ts'))).toBe(false);
  });

  it('applies multiple declared overlays in author-defined order', () => {
    const root = fixture(['sample-feature', 'second-feature']);
    write(
      root,
      '.template-features/second-feature/src/entry.ts',
      'export const value = "second";'
    );
    applyTemplateFeatures(root, new Set(['second-feature', 'sample-feature']));
    expect(readFileSync(join(root, 'src/entry.ts'), 'utf8')).toContain(
      '"second"'
    );
    expect(existsSync(join(root, 'src/optional.ts'))).toBe(true);
  });

  it('accepts an empty declaration without a payload directory', () => {
    const root = fixture([]);
    rmSync(join(root, '.template-features'), { recursive: true });
    applyTemplateFeatures(root, new Set());
    expect(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).template
        .features
    ).toBeUndefined();
  });

  it.each([{}, ['../escape'], ['sample-feature', 'sample-feature'], [false]])(
    'rejects malformed declarations (%j)',
    (features) => {
      const root = fixture(features);
      expect(() => applyTemplateFeatures(root, new Set())).toThrow(
        'template.features'
      );
      expect(existsSync(join(root, '.template-features'))).toBe(true);
      expect(readFileSync(join(root, 'src/entry.ts'), 'utf8')).toContain(
        '"base"'
      );
    }
  );

  it('does nothing to templates without a feature declaration', () => {
    const root = fixture();
    write(root, 'package.json', '{"name":"plain-template"}');
    applyTemplateFeatures(root, new Set(['sample-feature']));
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(
      '{"name":"plain-template"}'
    );
  });

  it('rejects overlays into tool-state directories', () => {
    const root = fixture();
    write(root, '.template-features/sample-feature/.git/config', 'invalid');
    expect(() =>
      applyTemplateFeatures(root, new Set(['sample-feature']))
    ).toThrow('tool-state');
    expect(readFileSync(join(root, 'src/entry.ts'), 'utf8')).toContain(
      '"base"'
    );
  });

  it('refuses destination directory junctions before writing', () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(
      outside,
      join(root, 'linked'),
      platform() === 'win32' ? 'junction' : 'dir'
    );
    write(
      root,
      '.template-features/sample-feature/linked/new.ts',
      'must not escape'
    );
    expect(() =>
      applyTemplateFeatures(root, new Set(['sample-feature']))
    ).toThrow('linked');
    expect(existsSync(join(outside, 'new.ts'))).toBe(false);
  });
});
