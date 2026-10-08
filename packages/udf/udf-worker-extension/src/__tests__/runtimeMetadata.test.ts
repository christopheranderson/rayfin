import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, test } from '@jest/globals';

import {
  loadRuntimeMetadata,
  MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION,
  RUNTIME_METADATA_FILENAME,
  RUNTIME_METADATA_SCHEMA_VERSION,
  resolveRuntimeMetadataPath,
  validateRuntimeMetadata,
} from '../runtimeMetadata.js';

function validMetadata(): unknown {
  return {
    schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
    functions: [
      {
        functionName: 'searchImportedWork',
        delegateParameters: [
          {
            name: 'ctx',
            type: 'RayfinContext',
            optional: false,
            hasDefault: false,
            position: 0,
            isFabricParameter: false,
          },
          {
            name: 'lakehouseConnection',
            type: 'FabricSqlConnection',
            optional: true,
            hasDefault: false,
            position: 1,
            isFabricParameter: true,
            fabricParameterType: 'FabricSqlConnection',
          },
          {
            name: 'fabricValue',
            optional: false,
            hasDefault: true,
            position: 2,
            isFabricParameter: true,
          },
        ],
      },
    ],
  };
}

describe('runtime metadata contract', () => {
  test('defines the stable runtime metadata filename and schema version', () => {
    expect(RUNTIME_METADATA_FILENAME).toBe('runtimemetadata.json');
    expect(RUNTIME_METADATA_SCHEMA_VERSION).toBe('2.0');
    expect(MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION).toBe('2.0');
  });

  test.each([
    ['an equal version', '2.0'],
    ['a newer minor', '2.7'],
    ['a newer minor, ordered numerically not lexically', '2.15'],
  ])('accepts %s', (_label, version: string) => {
    // Within a major the gate is a floor, so a newer CLI paired with an older
    // worker still loads. The closed key allowlists are what decide whether
    // its individual fields are understood.
    expect(
      validateRuntimeMetadata({
        ...(validMetadata() as Record<string, unknown>),
        schemaVersion: version,
      })
    ).toMatchObject({ status: 'valid' });
  });

  test.each([
    ['an older major', '1.9'],
    ['a newer major', '3.0'],
    ['a much newer major, ordered numerically not lexically', '10.0'],
  ])('rejects %s as unsupported', (_label, version: string) => {
    // A major bump means incompatible in either direction: the worker cannot
    // interpret a schema it predates, and must not guess at one it postdates.
    expect(
      validateRuntimeMetadata({
        ...(validMetadata() as Record<string, unknown>),
        schemaVersion: version,
      })
    ).toMatchObject({ status: 'unsupported-version', version });
  });

  test('rejects unknown function-level fields', () => {
    // The contract is deliberately closed: an older worker rejects any field
    // it does not know, so additions must be made worker-first.
    const withExtraField = validMetadata() as {
      functions: Record<string, unknown>[];
    };
    withExtraField.functions[0].genericAudiences = ['Sql'];

    expect(validateRuntimeMetadata(withExtraField)).toEqual({
      status: 'invalid',
      message: 'functions[0] must contain known fields only.',
    });
  });

  test('accepts and preserves contextAudiences', () => {
    const withAudiences = validMetadata() as {
      functions: Record<string, unknown>[];
    };
    withAudiences.functions[0].contextAudiences = ['ADO', 'Sql'];

    expect(validateRuntimeMetadata(withAudiences)).toEqual({
      status: 'valid',
      metadata: withAudiences,
    });
  });

  test('accepts an empty contextAudiences array', () => {
    const withEmpty = validMetadata() as {
      functions: Record<string, unknown>[];
    };
    withEmpty.functions[0].contextAudiences = [];

    expect(validateRuntimeMetadata(withEmpty)).toEqual({
      status: 'valid',
      metadata: withEmpty,
    });
  });

  test.each([
    ['a string', 'Sql'],
    ['a non-string entry', ['Sql', 3]],
    ['an empty-string entry', ['']],
  ])('rejects contextAudiences that is %s', (_label, contextAudiences) => {
    const invalidAudiences = validMetadata() as {
      functions: Record<string, unknown>[];
    };
    invalidAudiences.functions[0].contextAudiences = contextAudiences;

    expect(validateRuntimeMetadata(invalidAudiences)).toEqual({
      status: 'invalid',
      message:
        'functions[0].contextAudiences must be an array of non-empty strings.',
    });
  });

  test('accepts and normalizes valid runtime metadata', () => {
    expect(validateRuntimeMetadata(validMetadata())).toEqual({
      status: 'valid',
      metadata: validMetadata(),
    });
  });

  test.each([
    ['an older major', '1.0'],
    ['a non-dotted value', '2'],
    ['a non-numeric value', 'two.zero'],
    ['an empty value', ''],
  ])(
    'reports %s as unsupported rather than invalid',
    (_label, version: string) => {
      expect(
        validateRuntimeMetadata({
          schemaVersion: version,
          functions: [],
        })
      ).toEqual({
        status: 'unsupported-version',
        version,
      });
    }
  );

  test.each([
    ['a non-object root', null],
    [
      'unknown root fields',
      {
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [],
        unexpected: true,
      },
    ],
    [
      'duplicate function names',
      {
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          { functionName: 'duplicate', delegateParameters: [] },
          { functionName: 'duplicate', delegateParameters: [] },
        ],
      },
    ],
    [
      'out-of-order parameter positions',
      {
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: 'badPosition',
            delegateParameters: [
              {
                name: 'value',
                type: 'string',
                optional: false,
                hasDefault: false,
                position: 1,
                isFabricParameter: false,
              },
            ],
          },
        ],
      },
    ],
    [
      'fabric types on business parameters',
      {
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: 'badFabricType',
            delegateParameters: [
              {
                name: 'value',
                type: 'string',
                optional: false,
                hasDefault: false,
                position: 0,
                isFabricParameter: false,
                fabricParameterType: 'string',
              },
            ],
          },
        ],
      },
    ],
    [
      'fabric types that differ from the parameter type',
      {
        schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
        functions: [
          {
            functionName: 'mismatchedFabricType',
            delegateParameters: [
              {
                name: 'connection',
                type: 'FabricConnection',
                optional: false,
                hasDefault: false,
                position: 0,
                isFabricParameter: true,
                fabricParameterType: 'DataConnection',
              },
            ],
          },
        ],
      },
    ],
  ])('rejects %s', (_description, metadata) => {
    expect(validateRuntimeMetadata(metadata)).toEqual(
      expect.objectContaining({ status: 'invalid' })
    );
  });
});

describe('runtime metadata loading', () => {
  test('resolves metadata beside the project source root', () => {
    expect(resolveRuntimeMetadataPath(join('project', 'src'))).toBe(
      join(process.cwd(), 'project', RUNTIME_METADATA_FILENAME)
    );
  });

  test('loads and validates runtime metadata from disk', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-metadata-'));
    const metadataPath = join(projectRoot, RUNTIME_METADATA_FILENAME);
    try {
      writeFileSync(metadataPath, JSON.stringify(validMetadata()));

      expect(loadRuntimeMetadata(metadataPath)).toEqual({
        status: 'valid',
        metadata: validMetadata(),
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('distinguishes a missing file from malformed metadata', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-metadata-'));
    const metadataPath = join(projectRoot, RUNTIME_METADATA_FILENAME);
    try {
      expect(loadRuntimeMetadata(metadataPath)).toEqual({ status: 'missing' });

      writeFileSync(metadataPath, '{');
      expect(loadRuntimeMetadata(metadataPath)).toEqual({
        status: 'invalid',
        message: 'Runtime metadata must contain valid JSON.',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('propagates unexpected file-system errors', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-metadata-'));
    const directoryPath = join(projectRoot, RUNTIME_METADATA_FILENAME);
    try {
      mkdirSync(directoryPath);

      expect(() => loadRuntimeMetadata(directoryPath)).toThrow();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
