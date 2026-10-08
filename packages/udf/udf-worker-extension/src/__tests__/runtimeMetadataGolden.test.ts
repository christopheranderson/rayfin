import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Consumer half of the CLI <-> worker metadata contract.
//
// `packages/tools/cli` writes `fixtures/parity-runtimemetadata.json` from
// `fixtures/parity-function-app.ts.txt` and asserts it matches byte for byte.
// This test feeds that same file into `UserDataFunctions` and asserts the
// bindings it registers are exactly the ones the CLI put in the deploy
// metadata. If the two analyzers ever disagree again, one of them fails.
// ---------------------------------------------------------------------------

jest.unstable_mockModule('@microsoft/rayfin-client', () => ({
  RayfinServerClient: class {
    data = {};
  },
}));

const registeredOptions: Record<string, { extraInputs: unknown[] }> = {};

jest.unstable_mockModule('@azure/functions', () => ({
  app: {
    http: (name: string, options: { extraInputs: unknown[] }) => {
      registeredOptions[name] = options;
    },
    setup: () => {},
  },
  input: {
    generic: (options: unknown) => options,
  },
}));

// The metadata file is valid, so the parser must never be reached. Throwing
// here turns a silent fallback into a failure.
jest.unstable_mockModule('../astparser.js', () => ({
  TypeScriptProjectParser: class {
    constructor() {
      throw new Error(
        'Runtime metadata should have been used; the AST parser must not run.'
      );
    }
  },
}));

// Deployed function apps do not ship `typescript`, so reading CLI-generated
// metadata must not load it — not even transitively through a static import.
// A throwing factory fails the `userDataFunctions.js` import below if it does.
jest.unstable_mockModule('typescript', () => {
  throw new Error(
    "Runtime metadata must be usable without the 'typescript' package."
  );
});

const { UserDataFunctions } = await import('../userDataFunctions.js');
const { Connection } = await import('../types/connection.js');
const { validateRuntimeMetadata } = await import('../runtimeMetadata.js');

function findRepoRoot(): string {
  let current = process.cwd();
  while (!existsSync(join(current, 'rush.json'))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('Could not find rush.json');
    }
    current = parent;
  }
  return current;
}

const FIXTURE_DIR = join(
  findRepoRoot(),
  'packages',
  'udf',
  'udf-worker-extension',
  'src',
  '__tests__',
  'fixtures'
);

interface DeployBindings {
  audiences: Record<string, string[]>;
  aliases: Record<string, string[]>;
}

function readDeployBindings(): DeployBindings {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'parity-deploy-bindings.json'), 'utf8')
  ) as DeployBindings;
}

/**
 * Register the fixture's functions against the CLI-generated metadata.
 *
 * The handlers are irrelevant — only the registration shape matters — but the
 * `connections` arguments must mirror `parity-function-app.ts.txt` exactly,
 * since alias and array-declared generic connections are unioned with the
 * annotation audiences the metadata carries.
 */
function registerFixtureFunctions(): void {
  const udf = new UserDataFunctions(
    join(FIXTURE_DIR, 'src'),
    join(FIXTURE_DIR, 'parity-runtimemetadata.json')
  );

  const noop = async (): Promise<string> => 'ok';

  udf.func('aliasedAudience', noop, []);
  udf.func('literalUnion', noop, []);
  udf.func('aliasedNever', noop, []);
  udf.func('narrowedSecrets', noop, []);
  udf.func('annotationAndArray', noop, [
    new Connection({ audienceType: 'Sql' as never }),
    new Connection({ audienceType: 'Fabric' as never }),
    new Connection({ alias: 'myLakehouse', argName: 'lakehouseConnection' }),
  ]);
  udf.func('noAudiences', noop, []);
  udf.func('namedContextParameter', noop, []);
  udf.func('namedContextSortedUnion', noop, []);
  udf.func('businessOnly', noop, []);
}

function registeredAudiences(name: string): string[] {
  return (registeredOptions[name]?.extraInputs ?? [])
    .map((binding) => (binding as { audienceType?: string }).audienceType)
    .filter((audience): audience is string => Boolean(audience));
}

function registeredAliases(name: string): string[] {
  return (registeredOptions[name]?.extraInputs ?? [])
    .map((binding) => (binding as { alias?: string }).alias)
    .filter((alias): alias is string => Boolean(alias));
}

describe('runtime metadata golden', () => {
  beforeEach(() => {
    for (const key of Object.keys(registeredOptions)) {
      delete registeredOptions[key];
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerFixtureFunctions();
  });

  test('the generated metadata passes the worker validator', () => {
    const metadata = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'parity-runtimemetadata.json'), 'utf8')
    ) as unknown;

    // A single rejected field discards the whole file and sends the worker
    // back to full source parsing — silently, since the fallback works. Assert
    // the status directly so that failure names the offending field instead of
    // surfacing as the parser mock throwing.
    expect(validateRuntimeMetadata(metadata)).toEqual(
      expect.objectContaining({ status: 'valid' })
    );
  });

  test('a context parameter named "context" keeps type and fabricParameterType aligned', () => {
    const metadata = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'parity-runtimemetadata.json'), 'utf8')
    ) as {
      functions: Array<{
        functionName: string;
        delegateParameters: Array<{
          name: string;
          type?: string;
          isFabricParameter: boolean;
          fabricParameterType?: string;
        }>;
      }>;
    };

    // `context` is classified as a Fabric parameter by name, so it carries
    // both strings. Normalising only `type` made them disagree, which the
    // validator rejects.
    const fabricParameters = metadata.functions
      .flatMap((fn) => fn.delegateParameters)
      .filter((parameter) => parameter.isFabricParameter);

    expect(
      fabricParameters.some((parameter) => parameter.name === 'context')
    ).toBe(true);
    for (const parameter of fabricParameters) {
      expect(parameter.fabricParameterType).toBe(parameter.type);
    }
  });

  test('registers the same audiences the CLI wrote into the deploy metadata', () => {
    const { audiences } = readDeployBindings();

    for (const [functionName, expected] of Object.entries(audiences)) {
      expect({ [functionName]: registeredAudiences(functionName) }).toEqual({
        [functionName]: expected,
      });
    }
  });

  test('registers the same alias connections the CLI wrote', () => {
    const { aliases } = readDeployBindings();

    for (const [functionName, expected] of Object.entries(aliases)) {
      expect({ [functionName]: registeredAliases(functionName) }).toEqual({
        [functionName]: expected,
      });
    }
  });

  test('binds an aliased audience the un-normalised annotation would have dropped', () => {
    // `RayfinContext<DataModel, SqlAccess>` in source. The CLI resolves the
    // alias and writes `AudienceType.Sql`, so the worker can bind it.
    expect(registeredAudiences('aliasedAudience')).toEqual(['Sql']);
  });

  test('never warns about an unrecognised audience name', () => {
    // Every audience reaching the worker is now a literal AudienceType member.
    // A warning here means the CLI emitted something the worker cannot bind.
    expect(console.warn).not.toHaveBeenCalled();
  });
});
