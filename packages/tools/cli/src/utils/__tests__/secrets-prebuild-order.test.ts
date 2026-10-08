import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Structural guard: the secret registry must be generated before every build.
 *
 * `generateFunctionsTypes` is what normally writes `secrets.generated.ts`, but
 * all four paths that compile the functions project build *first*. A project
 * with a secret declared in `rayfin.yml` and no generated file yet fails that
 * build with `TS2339: Property 'API_KEY' does not exist` and exits before the
 * generator is reached.
 *
 * Two of the four paths are covered behaviourally — the build is stubbed and
 * the assertion is that the file exists at the moment it runs:
 *
 * - deploy: `up-functions-secrets-order.test.ts`
 * - `rayfin dev`: `local-runtime-provisioner.test.ts`
 *
 * The other two build inside long command functions that need a deployed item,
 * auth, and a live `func start` to reach, and their existing suites mock `fs`.
 * This checks the ordering in the source instead, so moving or dropping the
 * call is still caught. Update the markers here if a build site is reworked.
 */
interface PreBuildSite {
  label: string;
  file: string;
  /** A distinctive substring of the build invocation that must come after. */
  buildMarker: string;
}

const SITES: PreBuildSite[] = [
  {
    label: 'rayfin functions init',
    file: 'src/commands/functions/functions-init.ts',
    buildMarker: "runNpm(['run', 'build']",
  },
  {
    label: 'rayfin dev functions apply',
    file: 'src/commands/dev/dev-functions.ts',
    buildMarker: 'await runFunctionsBuild({',
  },
  {
    label: 'rayfin dev',
    file: 'src/local-services/dev/local-runtime-provisioner.ts',
    buildMarker: 'await runBuild({',
  },
  {
    label: 'rayfin up (deploy)',
    file: 'src/commands/up/up-functions.ts',
    buildMarker: 'await runServiceBuildCommand(',
  },
];

function packageRoot(): string {
  let current = __dirname;
  while (!existsSync(join(current, 'package.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Could not find package.json');
    current = parent;
  }
  return current;
}

describe('secret registry generation precedes every functions build', () => {
  for (const site of SITES) {
    it(`${site.label} generates the registry before building`, () => {
      const source = readFileSync(join(packageRoot(), site.file), 'utf-8');

      const buildIndex = source.indexOf(site.buildMarker);
      expect(
        buildIndex,
        `build marker '${site.buildMarker}' not found in ${site.file}; update this test if the build site moved`
      ).toBeGreaterThan(-1);

      const generateIndex = source.indexOf('ensureSecretsTypes(');
      expect(
        generateIndex,
        `${site.file} must call ensureSecretsTypes() before it builds, or a declared secret with no secrets.generated.ts fails the build with TS2339`
      ).toBeGreaterThan(-1);

      expect(
        generateIndex,
        `${site.file} calls ensureSecretsTypes() after the build; it must run first`
      ).toBeLessThan(buildIndex);
    });
  }
});
