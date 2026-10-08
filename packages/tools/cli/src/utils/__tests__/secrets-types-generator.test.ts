import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readSecretNames, removeSecretMetadata } from '../config-utils';
import {
  ensureSecretsTypes,
  generateSecretsTypes,
  SECRETS_TYPES_FILENAME,
  SECRETS_TYPES_RELATIVE_PATH,
} from '../secrets-types-generator';

/** Scaffold a minimal Rayfin project with the given rayfin.yml body. */
function scaffold(root: string, yml: string): void {
  mkdirSync(join(root, 'rayfin', 'data'), { recursive: true });
  mkdirSync(join(root, 'rayfin', 'functions', 'src'), { recursive: true });
  writeFileSync(join(root, 'rayfin', 'rayfin.yml'), yml, 'utf-8');
  // findRayfinProjectRoot keys on package.json + rayfin/rayfin.yml
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'secrets-fixture', version: '1.0.0' }),
    'utf-8'
  );
}

function generated(root: string): string {
  return readFileSync(join(root, SECRETS_TYPES_RELATIVE_PATH), 'utf-8');
}

const BASE_YML = `id: fixture
name: fixture
version: 1.0.0
services:
  functions:
    enabled: true
`;

describe('secrets-types-generator', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `rayfin-secrets-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits never when rayfin.yml declares no secrets', () => {
    scaffold(root, BASE_YML);

    const result = generateSecretsTypes(root);

    expect(result.status).toBe('written');
    expect(result.secretNames).toEqual([]);
    // `never` makes Record<never, string> empty, so ctx.Secrets.X is an error.
    expect(generated(root)).not.toContain('declare module');
  });

  it('emits a union of the declared secret names', () => {
    scaffold(
      root,
      `${BASE_YML}secrets:
  - name: STRIPE_API_KEY
    description: Stripe key
  - name: WAREHOUSE_PASSWORD
    description: Warehouse password
`
    );

    const result = generateSecretsTypes(root);

    expect(result.secretNames).toEqual([
      'STRIPE_API_KEY',
      'WAREHOUSE_PASSWORD',
    ]);
    const output = generated(root);
    expect(output).toContain('STRIPE_API_KEY: string;');
    expect(output).toContain('WAREHOUSE_PASSWORD: string;');
    expect(output).toContain('AUTO-GENERATED');
  });

  it('sorts names so the file is stable regardless of declaration order', () => {
    scaffold(
      root,
      `${BASE_YML}secrets:
  - name: ZEBRA
  - name: ALPHA
  - name: MIDDLE
`
    );

    generateSecretsTypes(root);
    const sortedFirst = generated(root);

    rmSync(join(root, SECRETS_TYPES_RELATIVE_PATH));
    writeFileSync(
      join(root, 'rayfin', 'rayfin.yml'),
      `${BASE_YML}secrets:
  - name: ALPHA
  - name: MIDDLE
  - name: ZEBRA
`,
      'utf-8'
    );
    generateSecretsTypes(root);

    expect(generated(root)).toBe(sortedFirst);
  });

  it('does not rewrite the file when nothing changed', () => {
    scaffold(root, `${BASE_YML}secrets:\n  - name: API_KEY\n`);

    expect(generateSecretsTypes(root).status).toBe('written');
    // Avoids churning the file on every dev-server rebuild.
    expect(generateSecretsTypes(root).status).toBe('unchanged');
  });

  it('drops a secret from the type once it leaves rayfin.yml', () => {
    scaffold(
      root,
      `${BASE_YML}secrets:
  - name: KEEP_ME
  - name: DELETE_ME
`
    );
    generateSecretsTypes(root);
    expect(generated(root)).toContain('DELETE_ME: string;');

    expect(removeSecretMetadata('DELETE_ME', root).status).toBe('removed');
    generateSecretsTypes(root);

    const output = generated(root);
    expect(output).toContain('KEEP_ME: string;');
    expect(output).not.toContain('DELETE_ME');
  });

  it('creates rayfin/data when it does not exist yet', () => {
    mkdirSync(join(root, 'rayfin'), { recursive: true });
    writeFileSync(join(root, 'rayfin', 'rayfin.yml'), BASE_YML, 'utf-8');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }),
      'utf-8'
    );

    expect(generateSecretsTypes(root).status).toBe('written');
    expect(existsSync(join(root, SECRETS_TYPES_RELATIVE_PATH))).toBe(true);
  });

  it('emits a module augmentation targeting the SDK package', () => {
    scaffold(root, `${BASE_YML}secrets:\n  - name: API_KEY\n`);

    generateSecretsTypes(root);
    const output = generated(root);

    // Declaration merging is the whole mechanism: without the augmentation
    // block, RayfinSecretRegistry stays empty and ctx.Secrets exposes nothing.
    expect(output).toContain(
      "declare module '@microsoft/fabric-user-data-functions'"
    );
    expect(output).toContain('interface RayfinSecretRegistry');
    expect(output).toContain('API_KEY: string;');
    // Must be a module for the augmentation to apply.
    expect(output).toContain('export {};');
  });

  it('writes into the functions src tree, not the shared data folder', () => {
    scaffold(root, `${BASE_YML}secrets:\n  - name: API_KEY\n`);

    const result = generateSecretsTypes(root);

    // rayfin/data is shared with the frontend, which has no dependency on the
    // functions SDK — the augmentation must not land there.
    expect(SECRETS_TYPES_RELATIVE_PATH).toBe(
      'rayfin/functions/src/secrets.generated.ts'
    );
    expect(result.outputPath?.replace(/\\/g, '/')).toContain(
      'rayfin/functions/src'
    );
    expect(existsSync(join(root, 'rayfin', 'data', 'secrets.ts'))).toBe(false);
  });

  it('leaves the schema untouched', () => {
    scaffold(root, `${BASE_YML}secrets:\n  - name: API_KEY\n`);
    const schemaPath = join(root, 'rayfin', 'data', 'schema.ts');
    const original = `type Todo = { id: string };\nexport type AppSchema = { Todo: Todo };\n`;
    writeFileSync(schemaPath, original, 'utf-8');

    generateSecretsTypes(root);

    // No wiring step exists any more, so there is nothing for a user to miss.
    expect(readFileSync(schemaPath, 'utf-8')).toBe(original);
  });

  it('exposes a filename the typegen watcher can ignore', () => {
    // secrets.generated.ts lives under the watched src/ tree, so writing it
    // would otherwise re-trigger the functions typegen watcher — the same
    // reason types.ts is excluded there.
    expect(SECRETS_TYPES_FILENAME).toBe('secrets.generated.ts');
    expect(SECRETS_TYPES_RELATIVE_PATH.endsWith(SECRETS_TYPES_FILENAME)).toBe(
      true
    );
  });

  describe('services.functions.path', () => {
    /**
     * Both separator styles must land on the same directory.
     *
     * `validateServicePath` normalises them, so a Windows-authored
     * `path: 'packages\functions'` validates as `<root>/packages/functions` on
     * POSIX. Re-resolving the raw string there treats the backslash as an
     * ordinary filename character and writes to a directory literally named
     * `packages\functions` — generation reports success while the real
     * functions package never receives the types. (On Windows both styles are
     * separators, so this only fails on POSIX.)
     */
    for (const [label, configured] of [
      ['forward slashes', 'packages/functions'],
      ['backslashes', 'packages\\functions'],
    ] as const) {
      it(`writes under the configured path with ${label}`, () => {
        scaffold(
          root,
          `id: fixture
name: fixture
version: 1.0.0
services:
  functions:
    enabled: true
    path: '${configured}'
secrets:
  - name: API_KEY
`
        );
        mkdirSync(join(root, 'packages', 'functions', 'src'), {
          recursive: true,
        });

        const result = generateSecretsTypes(root);

        const expected = join(
          root,
          'packages',
          'functions',
          'src',
          SECRETS_TYPES_FILENAME
        );
        expect(result.status).toBe('written');
        expect(result.outputPath).toBe(expected);
        expect(existsSync(expected)).toBe(true);
        expect(readFileSync(expected, 'utf-8')).toContain('API_KEY: string;');

        // The default location must stay untouched — the whole point of
        // honouring the config is not leaving a stray rayfin/functions/ tree.
        expect(existsSync(join(root, SECRETS_TYPES_RELATIVE_PATH))).toBe(false);
      });
    }

    it('falls back to the default path when none is configured', () => {
      scaffold(root, `${BASE_YML}secrets:\n  - name: API_KEY\n`);

      const result = generateSecretsTypes(root);

      expect(result.outputPath).toBe(
        join(root, 'rayfin', 'functions', 'src', SECRETS_TYPES_FILENAME)
      );
    });

    it('refuses a path that escapes the project root', () => {
      scaffold(
        root,
        `id: fixture
name: fixture
version: 1.0.0
services:
  functions:
    enabled: true
    path: '../../outside'
`
      );

      expect(() => generateSecretsTypes(root)).toThrow(
        'escapes the project root'
      );
    });
  });

  describe('ensureSecretsTypes', () => {
    it('writes the registry when a secret is declared and no file exists yet', () => {
      // The state every build path can start from: rayfin.yml already declares
      // a secret (a fresh clone, or `secret set` run from another machine) but
      // secrets.generated.ts has never been produced locally. Handlers that
      // read ctx.Secrets.API_KEY fail the build with TS2339 until it is.
      scaffold(root, `${BASE_YML}secrets:\n  - name: API_KEY\n`);
      const generatedPath = join(root, SECRETS_TYPES_RELATIVE_PATH);
      expect(existsSync(generatedPath)).toBe(false);

      const result = ensureSecretsTypes(join(root, 'rayfin', 'functions'));

      expect(result?.status).toBe('written');
      expect(readFileSync(generatedPath, 'utf-8')).toContain(
        'API_KEY: string;'
      );
    });

    it('reports and swallows a failure instead of breaking the build', () => {
      scaffold(
        root,
        `id: fixture
name: fixture
version: 1.0.0
services:
  functions:
    enabled: true
    path: '../../outside'
secrets:
  - name: API_KEY
`
      );
      const warnings: string[] = [];

      const result = ensureSecretsTypes(root, (message) =>
        warnings.push(message)
      );

      // The authoritative call inside generateFunctionsTypes still throws; this
      // pre-build pass must not turn a config problem into a failed build.
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('secrets.generated.ts');
      expect(warnings[0]).toContain('escapes the project root');
    });

    it('is silent by default', () => {
      scaffold(
        root,
        `id: fixture
name: fixture
version: 1.0.0
services:
  functions:
    enabled: true
    path: '../../outside'
`
      );

      expect(() => ensureSecretsTypes(root)).not.toThrow();
    });
  });

  it('skips quietly outside a Rayfin project', () => {
    const orphan = join(root, 'not-a-project');
    mkdirSync(orphan, { recursive: true });

    const result = generateSecretsTypes(orphan);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('project-root-not-found');
  });

  it('degrades to no secrets when the secrets list is malformed', () => {
    scaffold(root, `${BASE_YML}secrets: not-a-list\n`);

    // Typegen must not fail a build over a malformed config.
    expect(readSecretNames(root)).toEqual([]);
    expect(generateSecretsTypes(root).status).toBe('written');
    expect(generated(root)).not.toContain('declare module');
  });

  it('ignores entries without a usable name', () => {
    scaffold(
      root,
      `${BASE_YML}secrets:
  - name: GOOD
  - description: no name here
  - name: ''
  - name: GOOD
`
    );

    expect(readSecretNames(root)).toEqual(['GOOD']);
  });
});

describe('removeSecretMetadata', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `rayfin-rm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports not-found for a secret that was never declared', () => {
    scaffold(root, `${BASE_YML}secrets:\n  - name: PRESENT\n`);

    expect(removeSecretMetadata('ABSENT', root).status).toBe('not-found');
    expect(readSecretNames(root)).toEqual(['PRESENT']);
  });

  it('preserves unrelated config when removing', () => {
    scaffold(root, `${BASE_YML}secrets:\n  - name: ONLY\n`);

    removeSecretMetadata('ONLY', root);

    const yml = readFileSync(join(root, 'rayfin', 'rayfin.yml'), 'utf-8');
    expect(yml).toContain('id: fixture');
    expect(yml).toContain('functions:');
    expect(readSecretNames(root)).toEqual([]);
  });

  it('skips quietly outside a Rayfin project', () => {
    const orphan = join(root, 'nope');
    mkdirSync(orphan, { recursive: true });

    expect(removeSecretMetadata('ANY', orphan)).toEqual({
      status: 'skipped',
      reason: 'project-root-not-found',
    });
  });
});
