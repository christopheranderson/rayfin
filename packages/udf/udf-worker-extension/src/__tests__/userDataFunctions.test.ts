import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  describe,
  test,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

import { AudienceType } from '../types/connection.js';
import type { RayfinContext } from '../types/rayfinContext.js';

// ---------------------------------------------------------------------------
// Mock @microsoft/rayfin-client — avoid ESM transform issues
// ---------------------------------------------------------------------------
jest.unstable_mockModule('@microsoft/rayfin-client', () => ({
  RayfinServerClient: class {
    data = {};
    constructor() {}
  },
}));

// ---------------------------------------------------------------------------
// Mock @azure/functions — capture handlers registered via app.http()
// ---------------------------------------------------------------------------
const registeredHandlers: Record<string, Function> = {};
const registeredOptions: Record<string, any> = {};

jest.unstable_mockModule('@azure/functions', () => ({
  app: {
    http: (name: string, opts: any) => {
      registeredHandlers[name] = opts.handler;
      registeredOptions[name] = opts;
    },
    setup: () => {},
  },
  input: {
    generic: (opts: unknown) => opts,
  },
}));

// ---------------------------------------------------------------------------
// Stage runtime metadata
// ---------------------------------------------------------------------------
// Runtime metadata is the only source of delegate-parameter information, so
// tests stage it here and `makeUdf()` writes it to a throwaway project.
const mockFunctions: Record<string, any> = {};

/**
 * Register metadata for a function name so `makeUdf()` includes it.
 * Call before `udf.func(name, ...)` to simulate what the CLI generates.
 */
function setParserMetadata(
  name: string,
  delegateParameters: any[],
  genericAudiences: string[] = []
) {
  mockFunctions[name] = {
    functionName: name,
    delegateParameters,
    contextAudiences: genericAudiences,
  };
}

// Must import after mock setup (ESM dynamic import)
const { UserDataFunctions, METADATA_UNAVAILABLE_MESSAGE } =
  await import('../userDataFunctions.js');
const { Connection } = await import('../types/connection.js');
const { UserThrownError } = await import('../errors/udfErrors.js');
const { RUNTIME_METADATA_FILENAME, RUNTIME_METADATA_SCHEMA_VERSION } =
  await import('../runtimeMetadata.js');
// Stands in for the CLI's type checker when building metadata fixtures: it
// yields the same sorted names the CLI writes to `contextAudiences`.
const { extractAudiencesFromTypeText } =
  await import('../internal/contextAudiences.js');

// Throwaway project roots created by `makeUdf()`, removed after each test.
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build an instance backed by the metadata staged with
 * {@link setParserMetadata}, written to a throwaway project.
 */
function makeUdf() {
  const layout = createProjectLayout(
    JSON.stringify({
      schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
      functions: Object.values(mockFunctions),
    })
  );
  temporaryRoots.push(layout.projectRoot);
  return new UserDataFunctions(layout.srcRoot);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProjectLayout(runtimeMetadata?: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'udf-project-'));
  const srcRoot = join(projectRoot, 'src');
  mkdirSync(srcRoot);
  if (runtimeMetadata !== undefined) {
    writeFileSync(
      join(projectRoot, RUNTIME_METADATA_FILENAME),
      runtimeMetadata
    );
  }
  return { projectRoot, srcRoot };
}

function makeRequest(
  body: Record<string, unknown>,
  headers?: Record<string, string>
) {
  const headerMap = new Map(
    Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    json: async () => body,
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  };
}

function makeContext(
  invocationId = 'test-invocation-id',
  bindingData?: Map<string, unknown>
) {
  return {
    invocationId,
    error: jest.fn(),
    log: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    trace: jest.fn(),
    extraInputs: {
      get: (binding: any) => {
        if (bindingData && binding && typeof binding === 'object') {
          return bindingData.get(binding.argName);
        }
        return undefined;
      },
    },
  };
}

async function callHandler(
  name: string,
  body: Record<string, unknown>,
  invocationId?: string,
  bindingData?: Map<string, unknown>,
  headers?: Record<string, string>
) {
  const handler = registeredHandlers[name];
  if (!handler) throw new Error(`No handler registered for "${name}"`);
  const req = makeRequest(body, headers);
  const ctx = makeContext(invocationId, bindingData);
  return { response: (await handler(req, ctx)) as any, context: ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handler envelope', () => {
  let originalIsLocal: string | undefined;

  beforeEach(() => {
    originalIsLocal = process.env.IsLocal;
    delete process.env.IsLocal;
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    for (const key of Object.keys(registeredOptions)) {
      delete registeredOptions[key];
    }
    for (const key of Object.keys(mockFunctions)) {
      delete mockFunctions[key];
    }
  });

  afterEach(() => {
    if (originalIsLocal === undefined) {
      delete process.env.IsLocal;
    } else {
      process.env.IsLocal = originalIsLocal;
    }
    jest.restoreAllMocks();
  });

  test.each([
    { error: undefined, status: 'Succeeded', httpStatus: 200 },
    {
      error: new UserThrownError('Rejected'),
      status: 'BadRequest',
      httpStatus: 422,
    },
    {
      error: new Error('Unexpected failure'),
      status: 'Failed',
      httpStatus: 500,
    },
  ])(
    'maps local registered handler status $status to $httpStatus',
    async ({ error, status, httpStatus }) => {
      process.env.IsLocal = 'true';
      setParserMetadata('local_response', []);
      const udf = makeUdf();
      udf.func('local_response', async () => {
        if (error) throw error;
        return 'ok';
      });

      const { response } = await callHandler('local_response', {});

      expect(response.status).toBe(httpStatus);
      expect(response.headers['x-fabric-udf-status']).toBe(status);
      expect(JSON.parse(response.body).status).toBe(status);
    }
  );

  test.each([
    { isLocal: 'false', httpStatus: 200 },
    { isLocal: 'true', httpStatus: 403 },
  ])(
    'enforces response size for registered handlers with IsLocal=$isLocal',
    async ({ isLocal, httpStatus }) => {
      process.env.IsLocal = isLocal;
      setParserMetadata('oversized_response', []);
      const handler = jest.fn(async () => 'x'.repeat(30 * 1024 * 1024));
      const udf = makeUdf();
      udf.func('oversized_response', handler);

      const { response, context } = await callHandler(
        'oversized_response',
        {},
        'oversized-invocation-id'
      );

      expect(response.status).toBe(httpStatus);
      expect(response.body.length).toBeLessThan(1024);
      expect(response.headers).toEqual({
        'Content-Type': 'application/json',
        'x-fabric-udf-status': 'ResponseTooLarge',
      });
      expect(JSON.parse(response.body)).toEqual({
        functionName: 'oversized_response',
        invocationId: 'oversized-invocation-id',
        status: 'ResponseTooLarge',
        output: '',
        errors: [
          {
            errorCode: 'ResponseTooLarge',
            message:
              "Function's response size is larger than the 30 megabyte limit.",
            properties: {},
          },
        ],
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(context.error).toHaveBeenCalledTimes(1);
    }
  );

  test('returns HTTP 400 for missing input when registered locally', async () => {
    process.env.IsLocal = 'true';
    setParserMetadata('local_input', [
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const handler = jest.fn(async (_name: string) => 'ok');
    const udf = makeUdf();
    udf.func('local_input', handler);

    const { response } = await callHandler('local_input', {});

    expect(response.status).toBe(400);
    expect(response.headers['x-fabric-udf-status']).toBe('BadRequest');
    expect(JSON.parse(response.body).errors[0].errorCode).toBe('MissingInput');
    expect(handler).not.toHaveBeenCalled();
  });

  test('request headers and body cannot enable local status mapping', async () => {
    setParserMetadata('non_local', []);
    const udf = makeUdf();
    udf.func('non_local', async () => {
      throw new UserThrownError('Rejected');
    });

    const { response } = await callHandler(
      'non_local',
      { IsLocal: 'true' },
      undefined,
      undefined,
      { IsLocal: 'true' }
    );

    expect(response.status).toBe(200);
    expect(response.headers['x-fabric-udf-status']).toBe('BadRequest');
    expect(JSON.parse(response.body).errors[0].errorCode).toBe('UserThrown');
  });

  test('loads sibling runtime metadata without constructing the AST parser', async () => {
    const layout = createProjectLayout(
      JSON.stringify({
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: 'precomputed',
            delegateParameters: [
              {
                name: 'ctx',
                type: 'RayfinContext<AppSchema>',
                optional: false,
                hasDefault: false,
                position: 0,
                isFabricParameter: false,
              },
              {
                name: 'count',
                type: 'number',
                optional: false,
                hasDefault: false,
                position: 1,
                isFabricParameter: false,
              },
            ],
          },
        ],
      })
    );
    try {
      const udf = new UserDataFunctions(layout.srcRoot);
      udf.func(
        'precomputed',
        async (
          ctx: RayfinContext<Record<string, any>, AudienceType.Fabric>,
          count: number
        ) => ({
          count: count + 1,
          token: ctx.Tokens.Fabric,
        }),
        [udf.connection({ audienceType: AudienceType.Fabric })]
      );

      expect(registeredOptions.precomputed.extraInputs).toEqual([
        expect.objectContaining({
          type: 'FabricItem',
          audienceType: 'Fabric',
          argName: '__generic_Fabric',
        }),
      ]);
      const bindingData = new Map<string, unknown>([
        [
          '__generic_Fabric',
          JSON.stringify({
            Endpoints: { Fabric: { AccessToken: 'precomputed-token' } },
          }),
        ],
      ]);
      const rayfinInfo = JSON.stringify({
        rayfinToken: 'rayfin-token',
        publishableKey: 'publishable-key',
        rayFinEndpoint: 'https://rayfin.example.com',
      });
      const { response } = await callHandler(
        'precomputed',
        { count: '4' },
        undefined,
        bindingData,
        { 'x-ms-rayfin-info': rayfinInfo }
      );
      expect(JSON.parse(response.body).output).toEqual({
        count: 5,
        token: 'precomputed-token',
      });
    } finally {
      rmSync(layout.projectRoot, { recursive: true, force: true });
    }
  });

  // ── unusable metadata puts the instance in the error state ──────────

  /**
   * Invoke a route registered while the instance was in the metadata error
   * state, and return the parsed envelope.
   */
  async function invokeErrored(name: string) {
    const { response } = await callHandler(name, {});
    return { response, body: JSON.parse(response.body) };
  }

  test.each([
    ['missing', undefined, 'was not found', 'missing'],
    ['malformed', '{', 'must contain valid JSON', 'invalid'],
    [
      'unsupported',
      JSON.stringify({ schemaVersion: '1.0', functions: [] }),
      "schema version '1.0'",
      'unsupported-version',
    ],
  ])(
    '%s runtime metadata registers routes that fail every invocation',
    async (_description, runtimeMetadata, diagnostic, reason) => {
      const layout = createProjectLayout(runtimeMetadata);
      temporaryRoots.push(layout.projectRoot);
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      const udf = new UserDataFunctions(layout.srcRoot);
      const handler = jest.fn(async () => 'never runs');
      udf.func('errored', handler);

      // The route has to exist, otherwise the host reports "No job functions
      // found" and the deployment gives no clue what is wrong.
      expect(registeredHandlers.errored).toBeDefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining(diagnostic));

      const { response, body } = await invokeErrored('errored');
      expect(body.status).toBe('Failed');
      expect(body.errors[0].message).toBe(METADATA_UNAVAILABLE_MESSAGE);
      // Callers get the category only. The metadata path stays in the logged
      // diagnostic, since `properties` is serialized into the response and
      // would otherwise hand out the host's filesystem layout.
      expect(body.errors[0].properties.reason).toBe(reason);
      expect(response.body).not.toContain(layout.projectRoot);
      expect(response.body).not.toContain('runtimemetadata.json');
      expect(handler).not.toHaveBeenCalled();
    }
  );

  test('the failing route reports HTTP 500 locally', async () => {
    process.env.IsLocal = 'true';
    const layout = createProjectLayout();
    temporaryRoots.push(layout.projectRoot);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const udf = new UserDataFunctions(layout.srcRoot);
    udf.func('errored', async () => 'never runs');

    const { response } = await invokeErrored('errored');
    expect(response.status).toBe(500);
    expect(response.headers['x-fabric-udf-status']).toBe('Failed');
  });

  test('construction does not throw when metadata is unusable', () => {
    const layout = createProjectLayout();
    temporaryRoots.push(layout.projectRoot);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => new UserDataFunctions(layout.srcRoot)).not.toThrow();
  });

  test('the error state registers no bindings', async () => {
    const layout = createProjectLayout();
    temporaryRoots.push(layout.projectRoot);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const udf = new UserDataFunctions(layout.srcRoot);
    // The audiences these connections would bind are exactly what could not
    // be determined, so nothing is bound.
    udf.func('errored', async (_ctx: RayfinContext) => 'ok', [
      udf.connection({ audienceType: AudienceType.Fabric }),
    ]);

    expect(registeredOptions.errored.extraInputs ?? []).toEqual([]);
  });

  test('create() resolves to an instance in the error state rather than rejecting', async () => {
    const layout = createProjectLayout();
    temporaryRoots.push(layout.projectRoot);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const udf = await UserDataFunctions.create(layout.srcRoot);
    udf.func('errored', async () => 'never runs');

    const { body } = await invokeErrored('errored');
    expect(body.errors[0].message).toBe(METADATA_UNAVAILABLE_MESSAGE);
  });

  // ── metadata from a CLI that predates contextAudiences ─────────────

  function legacyMetadata(...contextTypes: string[]): string {
    return JSON.stringify({
      schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
      functions: contextTypes.map((type, index) => ({
        functionName: `legacy_${index}`,
        delegateParameters: [
          {
            name: 'ctx',
            type,
            optional: false,
            hasDefault: false,
            position: 0,
            isFabricParameter: false,
          },
        ],
      })),
    });
  }

  test('legacy metadata declaring audiences enters the error state', async () => {
    const layout = createProjectLayout(
      legacyMetadata('RayfinContext<Model, AudienceType.Sql>')
    );
    temporaryRoots.push(layout.projectRoot);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const udf = new UserDataFunctions(layout.srcRoot);
    udf.func('legacy_0', async (_ctx: RayfinContext) => 'ok');

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('contextAudiences')
    );
    const { body } = await invokeErrored('legacy_0');
    expect(body.errors[0].message).toBe(METADATA_UNAVAILABLE_MESSAGE);
    expect(body.errors[0].properties.reason).toBe('legacy-metadata');
  });

  test('legacy metadata that declares no audiences still loads', () => {
    const layout = createProjectLayout(
      legacyMetadata(
        'RayfinContext',
        'RayfinContext<Model>',
        'RayfinContext<Model, never>',
        'string'
      )
    );
    temporaryRoots.push(layout.projectRoot);

    const udf = new UserDataFunctions(layout.srcRoot);
    udf.func('legacy_2', async (_ctx: RayfinContext) => 'ok');
    expect(registeredOptions['legacy_2'].extraInputs).toEqual([]);
  });

  test('happy path: returns Succeeded envelope with output', async () => {
    setParserMetadata('greet', [
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'age',
        type: 'number',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('greet', async (name: string, age: number) => {
      return `Hello ${name}, you are ${age} years old!`;
    });

    const { response } = await callHandler('greet', { name: 'Alice', age: 30 });
    const parsed = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['x-fabric-udf-status']).toBe('Succeeded');
    expect(parsed.functionName).toBe('greet');
    expect(parsed.invocationId).toBe('test-invocation-id');
    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('Hello Alice, you are 30 years old!');
    expect(parsed.errors).toEqual([]);
  });

  test('missing parameter: returns Failed envelope with MissingInput error', async () => {
    setParserMetadata('greet', [
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'age',
        type: 'number',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('greet', async (name: string, age: number) => {
      return `Hello ${name}, you are ${age} years old!`;
    });

    const { response, context } = await callHandler('greet', { name: 'Alice' });
    const parsed = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['x-fabric-udf-status']).toBe('BadRequest');
    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('MissingInput');
    expect(parsed.errors[0].properties.parameter_name).toBe('age');
    expect(context.error).toHaveBeenCalled();
  });

  test('user function throws generic Error: returns Failed with InternalError', async () => {
    setParserMetadata('boom', []);
    const udf = makeUdf();
    udf.func('boom', async () => {
      throw new Error('something broke');
    });

    const { response } = await callHandler('boom', {});
    const parsed = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['x-fabric-udf-status']).toBe('Failed');
    expect(parsed.status).toBe('Failed');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('InternalError');
    expect(parsed.errors[0].properties.error_message).toBe('something broke');
  });

  test('user function throws UserThrownError: returns BadRequest', async () => {
    setParserMetadata('validate_age', [
      {
        name: 'age',
        type: 'number',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('validate_age', async (age: number) => {
      if (age < 18) {
        throw new UserThrownError('Must be 18+', { age: String(age) });
      }
      return 'ok';
    });

    const { response } = await callHandler('validate_age', { age: 10 });
    const parsed = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['x-fabric-udf-status']).toBe('BadRequest');
    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('UserThrown');
    expect(parsed.errors[0].message).toBe('Must be 18+');
    expect(parsed.errors[0].properties.age).toBe('10');
  });

  test('invalid input type: returns Failed with InvalidInput error', async () => {
    setParserMetadata('typed_add', [
      {
        name: 'a',
        type: 'number',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'b',
        type: 'number',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('typed_add', async (a: number, b: number) => a + b);

    const { response } = await callHandler('typed_add', {
      a: 1,
      b: 'not-a-number',
    });
    const parsed = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['x-fabric-udf-status']).toBe('BadRequest');
    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('InvalidInput');
    expect(parsed.errors[0].properties.parameter_name).toBe('b');
  });

  test('parameters are passed by name, not by position in JSON', async () => {
    setParserMetadata('ordered', [
      {
        name: 'first',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'second',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('ordered', async (first: string, second: string) => {
      return `${first}-${second}`;
    });

    // JSON object key order is reversed compared to function signature
    const { response } = await callHandler('ordered', {
      second: 'B',
      first: 'A',
    });
    const parsed = JSON.parse(response.body);

    expect(parsed.output).toBe('A-B');
  });

  test('no-parameter function works', async () => {
    setParserMetadata('ping', []);
    const udf = makeUdf();
    udf.func('ping', async () => 'pong');

    const { response } = await callHandler('ping', {});
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('pong');
  });

  test('default parameter is used when not provided in body', async () => {
    setParserMetadata('greet_default', [
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'greeting',
        type: 'string',
        optional: true,
        hasDefault: true,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('greet_default', async (name: string, greeting = 'Hello') => {
      return `${greeting} ${name}!`;
    });

    const { response } = await callHandler('greet_default', { name: 'Alice' });
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('Hello Alice!');
  });

  test('default parameter can be overridden by body', async () => {
    setParserMetadata('greet_override', [
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'greeting',
        type: 'string',
        optional: true,
        hasDefault: true,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('greet_override', async (name: string, greeting = 'Hello') => {
      return `${greeting} ${name}!`;
    });

    const { response } = await callHandler('greet_override', {
      name: 'Alice',
      greeting: 'Hi',
    });
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('Hi Alice!');
  });

  test('console.log inside the user function is forwarded to the active invocation context', async () => {
    setParserMetadata('log_forwarding', [
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('log_forwarding', async (name: string) => {
      console.log('hello', name, { source: 'test' });
      return 'ok';
    });

    const { response, context } = await callHandler('log_forwarding', {
      name: 'Alice',
    });
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(context.log).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'hello',
      'Alice',
      { source: 'test' }
    );
  });

  test('all supported console methods are forwarded to context', async () => {
    setParserMetadata('multi_log_forwarding', []);
    const udf = makeUdf();
    udf.func('multi_log_forwarding', async () => {
      console.log('log-message');
      console.error('error-message');
      console.info('info-message');
      console.debug('debug-message');
      console.warn('warn-message');
      console.trace('trace-message');
      return 'ok';
    });

    const { response, context } = await callHandler('multi_log_forwarding', {});
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(context.log).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'log-message'
    );
    expect(context.error).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'error-message'
    );
    expect(context.info).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'info-message'
    );
    expect(context.debug).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'debug-message'
    );
    expect(context.warn).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'warn-message'
    );
    expect(context.trace).toHaveBeenCalled();
  });

  test('concurrent functions route logs to their respective invocation context', async () => {
    setParserMetadata('log_fn_a', [
      {
        name: 'value',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    setParserMetadata('log_fn_b', [
      {
        name: 'value',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('log_fn_a', async (value: string) => {
      console.log('function-a', value);
      await Promise.resolve();
      console.log('function-a-done', value);
      return 'a-ok';
    });
    udf.func('log_fn_b', async (value: string) => {
      console.log('function-b', value);
      await Promise.resolve();
      console.log('function-b-done', value);
      return 'b-ok';
    });

    const [a, b] = await Promise.all([
      callHandler('log_fn_a', { value: 'A' }, 'invocation-a'),
      callHandler('log_fn_b', { value: 'B' }, 'invocation-b'),
    ]);

    const parsedA = JSON.parse(a.response.body);
    const parsedB = JSON.parse(b.response.body);

    expect(parsedA.status).toBe('Succeeded');
    expect(parsedB.status).toBe('Succeeded');

    expect(a.context.log).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-a',
      'A'
    );
    expect(a.context.log).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-a-done',
      'A'
    );
    expect(b.context.log).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-b',
      'B'
    );
    expect(b.context.log).toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-b-done',
      'B'
    );

    expect(a.context.log).not.toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-b',
      'B'
    );
    expect(a.context.log).not.toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-b-done',
      'B'
    );
    expect(b.context.log).not.toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-a',
      'A'
    );
    expect(b.context.log).not.toHaveBeenCalledWith(
      '[UserDataFunctions]',
      'function-a-done',
      'A'
    );
  });
});

// ---------------------------------------------------------------------------
// RayfinContext from x-ms-rayfin-info header
// ---------------------------------------------------------------------------

describe('RayfinContext from request header', () => {
  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    for (const key of Object.keys(registeredOptions)) {
      delete registeredOptions[key];
    }
    for (const key of Object.keys(mockFunctions)) {
      delete mockFunctions[key];
    }
  });

  test('RayfinContext param is populated from x-ms-rayfin-info header', async () => {
    setParserMetadata('rayfin_header', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    let receivedCtx: unknown;
    udf.func('rayfin_header', async (ctx: RayfinContext, name: string) => {
      receivedCtx = ctx;
      return `hello ${name}`;
    });

    // RayfinContext should NOT register any extraInputs binding
    const opts = registeredOptions['rayfin_header'];
    expect(opts.extraInputs).toHaveLength(0);

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token123',
      publishableKey: 'pk_test_123',
      rayFinEndpoint: 'https://rayfin.example.com',
    });

    const { response } = await callHandler(
      'rayfin_header',
      { name: 'Alice' },
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('hello Alice');
    expect(receivedCtx).toBeDefined();
    expect((receivedCtx as any).baseUrl).toBe('https://rayfin.example.com');
    expect((receivedCtx as any).accessToken).toBe('token123');
    expect((receivedCtx as any).publishableKey).toBe('pk_test_123');
  });

  test('RayfinContext does not consume a Connection binding slot', async () => {
    setParserMetadata('rayfin_no_binding', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_no_binding', async (ctx: RayfinContext) => ctx, [
      new Connection({ alias: 'myCustomAlias', argName: 'ctx' }),
    ]);

    const opts = registeredOptions['rayfin_no_binding'];
    // The Connection for "ctx" should be ignored since it's a RayfinContext param
    // that reads from the header, not from bindings
    expect(opts.extraInputs).toHaveLength(0);
  });

  test('RayfinContext coexists with other Connection bindings', async () => {
    setParserMetadata('rayfin_mixed_bindings', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func(
      'rayfin_mixed_bindings',
      async (ctx: RayfinContext, name: string) => ({ ctx, name }),
      [new Connection({ alias: 'myOtherAlias', argName: 'someOtherParam' })]
    );

    const opts = registeredOptions['rayfin_mixed_bindings'];
    // Only the non-Rayfin Connection should be registered
    expect(opts.extraInputs).toHaveLength(1);
    expect(opts.extraInputs[0]).toEqual({
      type: 'FabricItem',
      alias: 'myOtherAlias',
      argName: 'someOtherParam',
    });
  });

  test('RayfinContext with generic type parameter is recognized as context', async () => {
    setParserMetadata('rayfin_generic', [
      {
        name: 'ctx',
        type: 'RayfinContext<AppSchema>',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
      {
        name: 'name',
        type: 'string',
        optional: false,
        hasDefault: false,
        position: 1,
        isFabricParameter: false,
      },
    ]);
    type AppSchema = { Todo: { id: string } };
    const udf = makeUdf();
    let receivedCtx: unknown;
    udf.func(
      'rayfin_generic',
      async (ctx: RayfinContext<AppSchema>, name: string) => {
        receivedCtx = ctx;
        return `hi ${name}`;
      }
    );

    // The param typed as RayfinContext<AppSchema> should not create a FabricItem
    // binding in extraInputs. This verifies that the type-matching logic handles
    // the generic form (e.g. "RayfinContext<AppSchema>") and not just the bare
    // "RayfinContext" identifier — preventing regressions if the predicate changes.
    const opts = registeredOptions['rayfin_generic'];
    expect(opts.extraInputs).toHaveLength(0);

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token456',
      publishableKey: 'pk_test_456',
      rayFinEndpoint: 'https://rayfin2.example.com',
    });

    const { response } = await callHandler(
      'rayfin_generic',
      { name: 'Bob' },
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('hi Bob');
    expect(receivedCtx).toBeDefined();
    expect((receivedCtx as any).baseUrl).toBe('https://rayfin2.example.com');
  });

  test('invalid x-ms-rayfin-info JSON returns BadRequest envelope', async () => {
    setParserMetadata('rayfin_bad_info_json', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_bad_info_json', async (ctx: RayfinContext) => {
      return ctx.baseUrl;
    });

    const { response } = await callHandler(
      'rayfin_bad_info_json',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': '{not-json' }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('InternalError');
    expect(parsed.errors[0].message).toContain(
      "Header 'x-ms-rayfin-info' contains invalid JSON"
    );
  });

  test('non-object x-ms-rayfin-info JSON returns BadRequest envelope', async () => {
    setParserMetadata('rayfin_bad_info_shape', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_bad_info_shape', async (ctx: RayfinContext) => {
      return ctx.baseUrl;
    });

    const { response } = await callHandler(
      'rayfin_bad_info_shape',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': '42' }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('InternalError');
    expect(parsed.errors[0].message).toContain(
      "Header 'x-ms-rayfin-info' contains invalid JSON"
    );
  });
});

// ---------------------------------------------------------------------------
// Generic connections (getToken via audience-based bindings)
// ---------------------------------------------------------------------------

describe('generic connections', () => {
  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    for (const key of Object.keys(registeredOptions)) {
      delete registeredOptions[key];
    }
    for (const key of Object.keys(mockFunctions)) {
      delete mockFunctions[key];
    }
  });

  test('registers bindings from audiences declared on the context annotation', async () => {
    setParserMetadata(
      'annotated_only',
      [
        {
          name: 'ctx',
          type: 'RayfinContext<DataModel, AudienceType.Sql | AudienceType.ADO>',
          optional: false,
          hasDefault: false,
          position: 0,
          isFabricParameter: false,
        },
      ],
      ['ADO', 'Sql']
    );
    const udf = makeUdf();
    // No connections argument at all — the annotation is the declaration.
    udf.func('annotated_only', async (_ctx: RayfinContext) => 'ok');

    const opts = registeredOptions['annotated_only'];
    expect(opts.extraInputs).toHaveLength(2);
    expect(opts.extraInputs.map((i: any) => i.audienceType)).toEqual([
      'ADO',
      'Sql',
    ]);
    expect(opts.extraInputs[0]).toMatchObject({
      type: 'FabricItem',
      argName: '__generic_ADO',
    });
  });

  test('applies audience scope overrides to annotation-declared bindings', async () => {
    setParserMetadata(
      'annotated_scope',
      [
        {
          name: 'ctx',
          type: 'RayfinContext<DataModel, AudienceType.AzureAI>',
          optional: false,
          hasDefault: false,
          position: 0,
          isFabricParameter: false,
        },
      ],
      ['AzureAI']
    );
    const udf = makeUdf();
    udf.func('annotated_scope', async (_ctx: RayfinContext) => 'ok', []);

    expect(registeredOptions['annotated_scope'].extraInputs[0]).toMatchObject({
      audienceType: 'AzureAI',
      audienceScope: 'https://ai.azure.com/user_impersonation',
    });
  });

  test('unions annotated audiences with the connections array without duplicating', async () => {
    setParserMetadata(
      'annotated_union',
      [
        {
          name: 'ctx',
          type: 'RayfinContext<DataModel, AudienceType.Sql>',
          optional: false,
          hasDefault: false,
          position: 0,
          isFabricParameter: false,
        },
      ],
      ['Sql']
    );
    const udf = makeUdf();
    udf.func('annotated_union', async (_ctx: RayfinContext) => 'ok', [
      // Sql is already declared on the annotation — must not bind twice.
      new Connection({ audienceType: 'Sql' as any }),
      new Connection({ audienceType: 'Fabric' as any }),
    ]);

    const opts = registeredOptions['annotated_union'];
    expect(opts.extraInputs.map((i: any) => i.audienceType)).toEqual([
      'Sql',
      'Fabric',
    ]);
  });

  test('resolves a token from an annotation-declared binding', async () => {
    setParserMetadata(
      'annotated_token',
      [
        {
          name: 'ctx',
          type: 'RayfinContext<DataModel, AudienceType.Fabric>',
          optional: false,
          hasDefault: false,
          position: 0,
          isFabricParameter: false,
        },
      ],
      ['Fabric']
    );
    const udf = makeUdf();
    udf.func(
      'annotated_token',
      async (ctx: RayfinContext<Record<string, any>, AudienceType.Fabric>) =>
        ctx.getToken(AudienceType.Fabric),
      []
    );

    const bindingData = new Map<string, unknown>([
      [
        '__generic_Fabric',
        JSON.stringify({
          Endpoints: { Fabric: { AccessToken: 'annotation-token' } },
        }),
      ],
    ]);
    const rayfinInfo = JSON.stringify({
      rayfinToken: 'rt',
      publishableKey: 'pk',
      rayFinEndpoint: 'https://rayfin.example.com',
    });

    const { response } = await callHandler(
      'annotated_token',
      {},
      undefined,
      bindingData,
      { 'x-ms-rayfin-info': rayfinInfo }
    );

    expect(JSON.parse(response.body).output).toBe('annotation-token');
  });

  test('reads audiences from contextAudiences in the metadata', () => {
    // The annotation text names an alias the worker cannot resolve; the
    // CLI-resolved contextAudiences field is what counts.
    const { projectRoot, srcRoot } = createProjectLayout(
      JSON.stringify({
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: 'from_metadata',
            delegateParameters: [
              {
                name: 'ctx',
                type: 'RayfinContext<DataModel, SqlOrFabric>',
                optional: false,
                hasDefault: false,
                position: 0,
                isFabricParameter: false,
              },
            ],
            contextAudiences: ['Fabric', 'Sql'],
          },
        ],
      })
    );

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const udf = new UserDataFunctions(srcRoot);
    // No connections argument at all.
    udf.func('from_metadata', async (_ctx: RayfinContext) => 'ok');

    const opts = registeredOptions['from_metadata'];
    expect(opts.extraInputs.map((i: any) => i.audienceType)).toEqual([
      'Fabric',
      'Sql',
    ]);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test.each([
    ['AudiencesOf<typeof CONNS>', 'AudiencesOf'],
    ['AudienceType.CosmosDB', 'CosmosDB'],
    ['AudienceType.Kusto', 'Kusto'],
    ['AudienceType.KeyVault', 'KeyVault'],
    ['AudienceType.WorkIQ', 'WorkIQ'],
    ['AudienceType.EventGrid', 'EventGrid'],
  ])(
    'warns and binds nothing for unsupported annotation %s',
    (annotation, audience) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { projectRoot, srcRoot } = createProjectLayout(
        JSON.stringify({
          schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
          functions: [
            {
              functionName: 'bad_annotation',
              delegateParameters: [
                {
                  name: 'ctx',
                  type: `RayfinContext<DataModel, ${annotation}>`,
                  optional: false,
                  hasDefault: false,
                  position: 0,
                  isFabricParameter: false,
                },
              ],
              contextAudiences: [audience],
            },
          ],
        })
      );

      const udf = new UserDataFunctions(srcRoot);
      udf.func('bad_annotation', async (_ctx: RayfinContext) => 'ok', []);

      expect(registeredOptions['bad_annotation'].extraInputs).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`'${audience}' in the RayfinContext annotation`)
      );

      warn.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  );

  test('registers generic connection as extraInput with FabricItem type', async () => {
    setParserMetadata('fabric_func', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('fabric_func', async (_ctx: RayfinContext) => 'ok', [
      new Connection({ audienceType: 'Fabric' as any }),
    ]);

    const opts = registeredOptions['fabric_func'];
    expect(opts.extraInputs).toHaveLength(1);
    expect(opts.extraInputs[0]).toMatchObject({
      type: 'FabricItem',
      audienceType: 'Fabric',
      argName: '__generic_Fabric',
    });
  });

  test('multiple generic connections register multiple extraInputs', async () => {
    setParserMetadata('multi_generic', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('multi_generic', async (_ctx: RayfinContext) => 'ok', [
      new Connection({ audienceType: 'Fabric' as any }),
      new Connection({ audienceType: 'ADO' as any }),
    ]);

    const opts = registeredOptions['multi_generic'];
    expect(opts.extraInputs).toHaveLength(2);
    expect(opts.extraInputs[0]).toMatchObject({
      type: 'FabricItem',
      audienceType: 'Fabric',
    });
    expect(opts.extraInputs[1]).toMatchObject({
      type: 'FabricItem',
      audienceType: 'ADO',
    });
  });

  test('Tokens exposes token from resolved generic binding', async () => {
    setParserMetadata('fabric_token', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    let receivedToken: string | undefined;
    udf.func(
      'fabric_token',
      async (ctx: RayfinContext<Record<string, any>, AudienceType.Fabric>) => {
        receivedToken = ctx.Tokens.Fabric;
        return receivedToken;
      },
      [udf.connection({ audienceType: AudienceType.Fabric })]
    );

    const bindingData = new Map<string, unknown>();
    bindingData.set(
      '__generic_Fabric',
      JSON.stringify({
        Endpoints: { Fabric: { AccessToken: 'my-fabric-token-abc' } },
      })
    );

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'rt',
      publishableKey: 'pk',
      rayFinEndpoint: 'https://rayfin.example.com',
    });

    const { response } = await callHandler(
      'fabric_token',
      {},
      undefined,
      bindingData,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('my-fabric-token-abc');
    expect(receivedToken).toBe('my-fabric-token-abc');
  });

  test('legacy call order exposes Tokens from declared audiences', async () => {
    setParserMetadata('legacy_order_fabric', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func(
      'legacy_order_fabric',
      async (ctx: RayfinContext<Record<string, any>, AudienceType.Fabric>) => {
        return ctx.Tokens.Fabric;
      },
      [udf.connection({ audienceType: AudienceType.Fabric })]
    );

    const bindingData = new Map<string, unknown>([
      [
        '__generic_Fabric',
        JSON.stringify({
          Endpoints: { Fabric: { AccessToken: 'legacy-order-token' } },
        }),
      ],
    ]);
    const rayfinInfo = JSON.stringify({
      rayfinToken: 'rt',
      publishableKey: 'pk',
      rayFinEndpoint: 'https://rayfin.example.com',
    });

    const { response } = await callHandler(
      'legacy_order_fabric',
      {},
      undefined,
      bindingData,
      { 'x-ms-rayfin-info': rayfinInfo }
    );

    expect(JSON.parse(response.body).output).toBe('legacy-order-token');
  });

  test('getToken throws when audience not declared in connections', async () => {
    setParserMetadata('no_ado', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func(
      'no_ado',
      async (ctx: RayfinContext<Record<string, any>, AudienceType.Fabric>) => {
        // The `as any` is deliberate: the compile-time check now rejects this
        // outright, so the cast is the only way to still exercise the runtime
        // guard that backs it up.
        return ctx.getToken(AudienceType.ADO as any);
      },
      [udf.connection({ audienceType: AudienceType.Fabric })]
    );

    const bindingData = new Map<string, unknown>();
    bindingData.set(
      '__generic_Fabric',
      JSON.stringify({
        Endpoints: { Fabric: { AccessToken: 'fabric-token' } },
      })
    );

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'rt',
      publishableKey: 'pk',
      rayFinEndpoint: 'https://rayfin.example.com',
    });

    const { response } = await callHandler(
      'no_ado',
      {},
      undefined,
      bindingData,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Failed');
    expect(parsed.errors[0].errorCode).toBe('InvalidInput');
    expect(parsed.errors[0].message).toMatch(
      /No token available for audience 'ADO'/
    );
  });

  test('duplicate audienceType connections are deduplicated', async () => {
    setParserMetadata('dup_generic', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('dup_generic', async (_ctx: RayfinContext) => 'ok', [
      new Connection({ audienceType: 'Fabric' as any }),
      new Connection({ audienceType: 'Fabric' as any }),
    ]);

    const opts = registeredOptions['dup_generic'];
    // Should only register one binding for the same audienceType
    expect(opts.extraInputs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Declaration sources
//
// Generic connections can be declared on the context annotation, in the
// `connections` array, or both. These pin every combination: which bindings get
// registered, in what order, and that duplicates collapse.
//
// Ordering rule: audiences from the annotation first (sorted, because the
// annotation is parsed and sorted for deterministic metadata), then any the
// array adds, in array order. Alias connections are unaffected and always come
// from the array.
// ---------------------------------------------------------------------------

describe('connection declaration sources', () => {
  const temporaryRoots: string[] = [];

  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    for (const key of Object.keys(registeredOptions)) {
      delete registeredOptions[key];
    }
    for (const key of Object.keys(mockFunctions)) {
      delete mockFunctions[key];
    }
  });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Register a function whose context annotation is `contextType`, going
   * through runtime metadata — the path production uses.
   */
  function registerWithMetadata(
    name: string,
    contextType: string,
    connections?: any[]
  ) {
    const { projectRoot, srcRoot } = createProjectLayout(
      JSON.stringify({
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: name,
            delegateParameters: [
              {
                name: 'ctx',
                type: contextType,
                optional: false,
                hasDefault: false,
                position: 0,
                isFabricParameter: false,
              },
            ],
            contextAudiences: extractAudiencesFromTypeText(contextType),
          },
        ],
      })
    );
    temporaryRoots.push(projectRoot);

    const udf = new UserDataFunctions(srcRoot);
    const handler = async (ctx: any) => ctx;
    if (connections === undefined) {
      udf.func(name, handler);
    } else {
      udf.func(
        name,
        handler,
        connections.map((c) => (typeof c === 'function' ? c(udf) : c))
      );
    }
    return udf;
  }

  function audiencesOf(name: string): string[] {
    return (registeredOptions[name].extraInputs as any[])
      .map((i) => i.audienceType)
      .filter(Boolean);
  }

  function aliasesOf(name: string): string[] {
    return (registeredOptions[name].extraInputs as any[])
      .map((i) => i.alias)
      .filter(Boolean);
  }

  const generic = (audienceType: AudienceType) => (udf: any) =>
    udf.connection({ audienceType });
  const alias = (aliasName: string) => (udf: any) =>
    udf.connection({ alias: aliasName });

  const CTX = 'RayfinContext<Model, ';

  const cases: Array<{
    id: string;
    contextType: string;
    connections?: any[];
    expected: string[];
  }> = [
    // ── annotation only ────────────────────────────────────────────────
    {
      id: 'annotation only, third argument omitted',
      contextType: `${CTX}AudienceType.Sql>`,
      connections: undefined,
      expected: ['Sql'],
    },
    {
      id: 'annotation only, empty array',
      contextType: `${CTX}AudienceType.Sql>`,
      connections: [],
      expected: ['Sql'],
    },
    {
      id: 'annotation only, union',
      contextType: `${CTX}AudienceType.Sql | AudienceType.ADO>`,
      connections: [],
      expected: ['ADO', 'Sql'],
    },
    {
      id: 'annotation only, repeated audience collapses',
      contextType: `${CTX}AudienceType.Sql | AudienceType.Sql>`,
      connections: [],
      expected: ['Sql'],
    },

    // ── array only ─────────────────────────────────────────────────────
    {
      id: 'array only, schema-only annotation',
      contextType: 'RayfinContext<Model>',
      connections: [generic(AudienceType.Sql)],
      expected: ['Sql'],
    },
    {
      id: 'array only, bare annotation',
      contextType: 'RayfinContext',
      connections: [generic(AudienceType.Fabric)],
      expected: ['Fabric'],
    },
    {
      id: 'array only, duplicate entries collapse',
      contextType: 'RayfinContext<Model>',
      connections: [generic(AudienceType.Sql), generic(AudienceType.Sql)],
      expected: ['Sql'],
    },
    {
      id: 'array only, multiple audiences keep array order',
      contextType: 'RayfinContext<Model>',
      connections: [
        generic(AudienceType.Storage),
        generic(AudienceType.Fabric),
      ],
      expected: ['Storage', 'Fabric'],
    },

    // ── both ───────────────────────────────────────────────────────────
    {
      id: 'both, same audience declared twice',
      contextType: `${CTX}AudienceType.Fabric>`,
      connections: [generic(AudienceType.Fabric)],
      expected: ['Fabric'],
    },
    {
      id: 'both, different audiences union',
      contextType: `${CTX}AudienceType.Sql>`,
      connections: [generic(AudienceType.Fabric)],
      expected: ['Sql', 'Fabric'],
    },
    {
      id: 'both, partially overlapping',
      contextType: `${CTX}AudienceType.Sql | AudienceType.Fabric>`,
      connections: [
        generic(AudienceType.Fabric),
        generic(AudienceType.Storage),
      ],
      expected: ['Fabric', 'Sql', 'Storage'],
    },

    // ── neither ────────────────────────────────────────────────────────
    {
      id: 'neither, schema-only annotation and empty array',
      contextType: 'RayfinContext<Model>',
      connections: [],
      expected: [],
    },
    {
      id: 'neither, third argument omitted',
      contextType: 'RayfinContext<Model>',
      connections: undefined,
      expected: [],
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    test(`${testCase.id}`, () => {
      const name = `decl_case_${index}`;
      registerWithMetadata(name, testCase.contextType, testCase.connections);

      expect(audiencesOf(name)).toEqual(testCase.expected);
      // Every generic binding carries the synthetic argName the host routes on.
      for (const audience of testCase.expected) {
        expect(
          (registeredOptions[name].extraInputs as any[]).some(
            (i) => i.argName === `__generic_${audience}`
          )
        ).toBe(true);
      }
    });
  }

  test('alias connections are independent of annotated audiences', () => {
    registerWithMetadata('decl_alias_mixed', `${CTX}AudienceType.Sql>`, [
      alias('myLakehouse'),
      generic(AudienceType.Fabric),
    ]);

    expect(audiencesOf('decl_alias_mixed')).toEqual(['Sql', 'Fabric']);
    expect(aliasesOf('decl_alias_mixed')).toEqual(['myLakehouse']);
  });

  test('alias-only connections contribute no audiences', () => {
    registerWithMetadata('decl_alias_only', 'RayfinContext<Model>', [
      alias('myLakehouse'),
    ]);

    expect(audiencesOf('decl_alias_only')).toEqual([]);
    expect(aliasesOf('decl_alias_only')).toEqual(['myLakehouse']);
  });

  // ── end-to-end token resolution for each declaration source ──────────

  const rayfinInfoHeader = JSON.stringify({
    rayfinToken: 'rt',
    publishableKey: 'pk',
    rayFinEndpoint: 'https://rayfin.example.com',
  });

  function bindingPayload(audience: string, token: string) {
    return JSON.stringify({
      Endpoints: { [audience]: { AccessToken: token } },
    });
  }

  const tokenResolutionCases: Array<{
    label: string;
    contextType: string;
    connections?: Array<(udf: any) => any>;
  }> = [
    {
      label: 'annotation only',
      contextType: `${CTX}AudienceType.Fabric>`,
      connections: undefined,
    },
    {
      label: 'array only',
      contextType: 'RayfinContext<Model>',
      connections: [generic(AudienceType.Fabric)],
    },
    {
      label: 'both',
      contextType: `${CTX}AudienceType.Fabric>`,
      connections: [generic(AudienceType.Fabric)],
    },
  ];

  for (const [
    index,
    { label, contextType, connections },
  ] of tokenResolutionCases.entries()) {
    test(`resolves a token when declared via ${label}`, async () => {
      const name = `decl_token_${index}`;
      const { projectRoot, srcRoot } = createProjectLayout(
        JSON.stringify({
          schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
          functions: [
            {
              functionName: name,
              delegateParameters: [
                {
                  name: 'ctx',
                  type: contextType,
                  optional: false,
                  hasDefault: false,
                  position: 0,
                  isFabricParameter: false,
                },
              ],
              contextAudiences: extractAudiencesFromTypeText(contextType),
            },
          ],
        })
      );
      temporaryRoots.push(projectRoot);

      const udf = new UserDataFunctions(srcRoot);
      const handler = async (ctx: any) => ctx.getToken(AudienceType.Fabric);
      if (connections === undefined) {
        udf.func(name, handler);
      } else {
        udf.func(
          name,
          handler,
          connections.map((c) => c(udf))
        );
      }

      const bindingData = new Map<string, unknown>([
        ['__generic_Fabric', bindingPayload('Fabric', 'fabric-token')],
      ]);

      const { response } = await callHandler(name, {}, undefined, bindingData, {
        'x-ms-rayfin-info': rayfinInfoHeader,
      });

      expect(JSON.parse(response.body).output).toBe('fabric-token');
    });
  }

  test('a duplicate declaration still binds exactly one input', async () => {
    const name = 'decl_dup_single_binding';
    const { projectRoot, srcRoot } = createProjectLayout(
      JSON.stringify({
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: name,
            delegateParameters: [
              {
                name: 'ctx',
                type: `${CTX}AudienceType.Fabric>`,
                optional: false,
                hasDefault: false,
                position: 0,
                isFabricParameter: false,
              },
            ],
            contextAudiences: ['Fabric'],
          },
        ],
      })
    );
    temporaryRoots.push(projectRoot);

    const udf = new UserDataFunctions(srcRoot);
    udf.func(name, async (ctx: any) => ctx.Tokens.Fabric, [
      udf.connection({ audienceType: AudienceType.Fabric }),
    ]);

    // Declared in both places, bound once — a second binding would make the
    // host mint the same token twice.
    expect(registeredOptions[name].extraInputs).toHaveLength(1);

    const bindingData = new Map<string, unknown>([
      ['__generic_Fabric', bindingPayload('Fabric', 'fabric-token')],
    ]);
    const { response } = await callHandler(name, {}, undefined, bindingData, {
      'x-ms-rayfin-info': rayfinInfoHeader,
    });
    expect(JSON.parse(response.body).output).toBe('fabric-token');
  });
});

describe('secrets via x-ms-rayfin-secrets header', () => {
  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    for (const key of Object.keys(registeredOptions)) {
      delete registeredOptions[key];
    }
    for (const key of Object.keys(mockFunctions)) {
      delete mockFunctions[key];
    }
  });

  test('RayfinContext getSecret reads values from x-ms-rayfin-secrets header', async () => {
    setParserMetadata('rayfin_secret', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_secret', async (ctx: RayfinContext) => {
      return ctx.getSecret('apiKey') ?? null;
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token789',
      publishableKey: 'pk_test_789',
      rayFinEndpoint: 'https://rayfin3.example.com',
    });
    const rayfinSecrets = JSON.stringify({
      apiKey: 'secret-value',
      anotherSecret: 'another-value',
    });

    const { response } = await callHandler(
      'rayfin_secret',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo, 'x-ms-rayfin-secrets': rayfinSecrets }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('secret-value');
  });

  test('RayfinContext getSecret returns undefined for unknown secret', async () => {
    setParserMetadata('rayfin_unknown_secret', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_unknown_secret', async (ctx: RayfinContext) => {
      return ctx.getSecret('missing') ?? 'none';
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token999',
      publishableKey: 'pk_test_999',
      rayFinEndpoint: 'https://rayfin4.example.com',
    });

    const { response } = await callHandler(
      'rayfin_unknown_secret',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('none');
  });

  test('RayfinContext getSecret falls back to process.env when header secret is missing', async () => {
    process.env.RAYFIN_ENV_SECRET = 'env-secret-value';
    setParserMetadata('rayfin_env_secret', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_env_secret', async (ctx: RayfinContext) => {
      return ctx.getSecret('RAYFIN_ENV_SECRET') ?? null;
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token-env',
      publishableKey: 'pk_test_env',
      rayFinEndpoint: 'https://rayfin-env.example.com',
    });

    const { response } = await callHandler(
      'rayfin_env_secret',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('env-secret-value');

    delete process.env.RAYFIN_ENV_SECRET;
  });

  test('RayfinContext getSecret prefers header secret over process.env fallback', async () => {
    process.env.RAYFIN_SHARED_SECRET = 'env-shared-value';
    setParserMetadata('rayfin_secret_precedence', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_secret_precedence', async (ctx: RayfinContext) => {
      return ctx.getSecret('RAYFIN_SHARED_SECRET') ?? null;
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token-precedence',
      publishableKey: 'pk_test_precedence',
      rayFinEndpoint: 'https://rayfin-precedence.example.com',
    });
    const rayfinSecrets = JSON.stringify({
      RAYFIN_SHARED_SECRET: 'header-shared-value',
    });

    const { response } = await callHandler(
      'rayfin_secret_precedence',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo, 'x-ms-rayfin-secrets': rayfinSecrets }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('header-shared-value');

    delete process.env.RAYFIN_SHARED_SECRET;
  });

  test('RayfinContext getSecret does not fallback to process.env when header secret is empty string', async () => {
    process.env.RAYFIN_EMPTY_SECRET = 'env-empty-value';
    setParserMetadata('rayfin_empty_header_secret', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_empty_header_secret', async (ctx: RayfinContext) => {
      return ctx.getSecret('RAYFIN_EMPTY_SECRET') ?? null;
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token-empty',
      publishableKey: 'pk_test_empty',
      rayFinEndpoint: 'https://rayfin-empty.example.com',
    });
    const rayfinSecrets = JSON.stringify({
      RAYFIN_EMPTY_SECRET: '',
    });

    const { response } = await callHandler(
      'rayfin_empty_header_secret',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo, 'x-ms-rayfin-secrets': rayfinSecrets }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe('');

    delete process.env.RAYFIN_EMPTY_SECRET;
  });

  test('RayfinContext getSecret is undefined when missing in both header and process.env', async () => {
    delete process.env.RAYFIN_MISSING_SECRET;
    setParserMetadata('rayfin_missing_secret_sources', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func(
      'rayfin_missing_secret_sources',
      async (ctx: RayfinContext) =>
        ctx.getSecret('RAYFIN_MISSING_SECRET') === undefined
    );

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token-missing',
      publishableKey: 'pk_test_missing',
      rayFinEndpoint: 'https://rayfin-missing.example.com',
    });

    const { response } = await callHandler(
      'rayfin_missing_secret_sources',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('Succeeded');
    expect(parsed.output).toBe(true);
  });

  test('invalid x-ms-rayfin-secrets JSON returns BadRequest envelope', async () => {
    setParserMetadata('rayfin_bad_secret_json', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_bad_secret_json', async (ctx: RayfinContext) => {
      return ctx.getSecret('apiKey') ?? null;
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token111',
      publishableKey: 'pk_test_111',
      rayFinEndpoint: 'https://rayfin5.example.com',
    });

    const { response } = await callHandler(
      'rayfin_bad_secret_json',
      {},
      undefined,
      undefined,
      { 'x-ms-rayfin-info': rayfinInfo, 'x-ms-rayfin-secrets': '{not-json' }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('InternalError');
    expect(parsed.errors[0].message).toContain('x-ms-rayfin-secrets');
  });

  test('non-string secret value in x-ms-rayfin-secrets returns BadRequest envelope', async () => {
    setParserMetadata('rayfin_bad_secret_value', [
      {
        name: 'ctx',
        type: 'RayfinContext',
        optional: false,
        hasDefault: false,
        position: 0,
        isFabricParameter: false,
      },
    ]);
    const udf = makeUdf();
    udf.func('rayfin_bad_secret_value', async (ctx: RayfinContext) => {
      return ctx.getSecret('apiKey') ?? null;
    });

    const rayfinInfo = JSON.stringify({
      rayfinToken: 'token222',
      publishableKey: 'pk_test_222',
      rayFinEndpoint: 'https://rayfin6.example.com',
    });

    const { response } = await callHandler(
      'rayfin_bad_secret_value',
      {},
      undefined,
      undefined,
      {
        'x-ms-rayfin-info': rayfinInfo,
        'x-ms-rayfin-secrets': JSON.stringify({ apiKey: 123 }),
      }
    );
    const parsed = JSON.parse(response.body);

    expect(parsed.status).toBe('BadRequest');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].errorCode).toBe('InternalError');
    expect(parsed.errors[0].message).toContain('non-string value');
  });
});
