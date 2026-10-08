import { describe, expect, it } from 'vitest';

import {
  parseRayfinYaml,
  parseRayfinYamlInterpolated,
} from '../config/parseRayfinYaml.js';
import { validateFunctionsConfig } from '../config/validateFunctionsConfig.js';

describe('validateFunctionsConfig', () => {
  it.each([true, false, undefined, 'true', 'false', 'yes', 'on', 1])(
    'accepts explicit application auth (enabled=%s)',
    (enabled) => {
      expect(
        validateFunctionsConfig({ enabled, auth: { type: 'application' } })
      ).toEqual([]);
    }
  );

  it.each([
    undefined,
    null,
    {},
    { enabled: false },
    { enabled: false, auth: undefined },
  ])('allows absent or disabled Functions without auth: %j', (functions) => {
    expect(validateFunctionsConfig(functions)).toEqual([]);
  });

  it.each([{ enabled: true }, { enabled: true, auth: undefined }])(
    'requires explicit auth when Functions are enabled: %j',
    (functions) => {
      expect(validateFunctionsConfig(functions)).toEqual([
        {
          field: 'services.functions.auth',
          message:
            'Invalid services.functions.auth: authentication is required when ' +
            'Functions are enabled. Set services.functions.auth.type to "application".',
        },
      ]);
    }
  );

  it.each([
    { yaml: 'true', enabled: true },
    { yaml: 'True', enabled: true },
    { yaml: '"true"', enabled: 'true' },
    { yaml: '"false"', enabled: 'false' },
    { yaml: 'yes', enabled: 'yes' },
    { yaml: 'on', enabled: 'on' },
    { yaml: '1', enabled: 1 },
    { yaml: '[]', enabled: [] },
    { yaml: '{}', enabled: {} },
  ])(
    'requires auth for truthy YAML enabled: $yaml without coercing it',
    ({ yaml, enabled }) => {
      const config = parseRayfinYaml(
        `id: app\nservices:\n  functions:\n    enabled: ${yaml}\n`
      );
      const functions = config.services.functions;

      expect(functions?.enabled).toEqual(enabled);
      expect(functions?.enabled).toBeTruthy();
      expect(validateFunctionsConfig(functions)).toEqual([
        {
          field: 'services.functions.auth',
          message:
            'Invalid services.functions.auth: authentication is required when ' +
            'Functions are enabled. Set services.functions.auth.type to "application".',
        },
      ]);
      expect(functions?.enabled).toEqual(enabled);
      expect(functions?.auth).toBeUndefined();
    }
  );

  it.each(['false', 'False', 'null', '~', '0', '""'])(
    'allows omitted auth for falsy YAML enabled: %s without adding defaults',
    (yaml) => {
      const config = parseRayfinYaml(
        `id: app\nservices:\n  functions:\n    enabled: ${yaml}\n`
      );
      const functions = config.services.functions;
      const before = structuredClone(functions);

      expect(functions?.enabled).toBeFalsy();
      expect(validateFunctionsConfig(functions)).toEqual([]);
      expect(functions).toEqual(before);
    }
  );

  it.each([true, false, undefined])(
    'requires a type in an explicit auth block (enabled=%s)',
    (enabled) => {
      for (const auth of [{}, { type: undefined }]) {
        expect(validateFunctionsConfig({ enabled, auth })).toEqual([
          {
            field: 'services.functions.auth.type',
            message:
              'Invalid services.functions.auth.type: a type is required. ' +
              'Set services.functions.auth.type to "application".',
          },
        ]);
      }
    }
  );

  it.each([
    'delegated',
    'none',
    'unknown',
    'Application',
    'APPLICATION',
    ' application ',
    '',
    true,
    false,
    0,
    1,
  ])('rejects unsupported auth type %j even when disabled', (type) => {
    for (const enabled of [true, false]) {
      expect(validateFunctionsConfig({ enabled, auth: { type } })).toEqual([
        expect.objectContaining({
          field: 'services.functions.auth.type',
          message: expect.stringContaining(
            'Set services.functions.auth.type to "application".'
          ),
        }),
      ]);
    }
  });

  it.each([true, false])(
    'rejects explicit null authentication settings when enabled is %s',
    (enabled) => {
      expect(validateFunctionsConfig({ enabled, auth: null })).toEqual([
        {
          field: 'services.functions.auth',
          message:
            'Invalid services.functions.auth: expected a mapping with a ' +
            '"type" field, but found "null". Set ' +
            'services.functions.auth.type to "application".',
        },
      ]);
      expect(
        validateFunctionsConfig({ enabled, auth: { type: null } })
      ).toEqual([
        {
          field: 'services.functions.auth.type',
          message:
            'Invalid services.functions.auth.type: found "null". ' +
            'Only application authentication is supported. ' +
            'Set services.functions.auth.type to "application".',
        },
      ]);
    }
  );

  it.each(['null', '~', ''])(
    'rejects YAML null spelling "%s" after parsing',
    (value) => {
      for (const [authYaml, field] of [
        [`auth: ${value}`, 'services.functions.auth'],
        [`auth:\n      type: ${value}`, 'services.functions.auth.type'],
      ]) {
        const config = parseRayfinYaml(`
id: test-app
services:
  functions:
    enabled: true
    ${authYaml}
`);

        expect(validateFunctionsConfig(config.services.functions)).toEqual([
          expect.objectContaining({
            field,
            message: expect.stringContaining('"null"'),
          }),
        ]);
      }
    }
  );

  it('returns an actionable error for an unsupported auth type', () => {
    const errors = validateFunctionsConfig({
      enabled: true,
      auth: { type: 'appAuth' },
    });

    expect(errors).toEqual([
      {
        field: 'services.functions.auth.type',
        message:
          'Invalid services.functions.auth.type: found "appAuth". ' +
          'Only application authentication is supported. ' +
          'Set services.functions.auth.type to "application".',
      },
    ]);
  });

  it.each(['Application', 'DELEGATED'])(
    'rejects non-canonical auth type %s without normalizing it',
    (type) => {
      const errors = validateFunctionsConfig({
        enabled: true,
        auth: { type },
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(`auth.type: found "${type}"`);
    }
  );

  it.each(['delegated', 'application', true, false, 0, 1])(
    'rejects a scalar auth block %j that the host could not deserialize',
    (auth) => {
      const errors = validateFunctionsConfig({ enabled: true, auth });

      expect(errors).toEqual([
        {
          field: 'services.functions.auth',
          message:
            'Invalid services.functions.auth: expected a mapping with a ' +
            `"type" field, but found "${auth}". Set ` +
            'services.functions.auth.type to "application".',
        },
      ]);
    }
  );

  it('rejects a sequence auth block', () => {
    const errors = validateFunctionsConfig({
      enabled: true,
      auth: ['delegated'],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('services.functions.auth');
    expect(errors[0].message).toContain('found a list');
  });

  it.each([
    { type: ['delegated'], description: 'a list' },
    { type: { value: 'delegated' }, description: 'a mapping' },
  ])(
    'describes an invalid auth type as $description',
    ({ type, description }) => {
      const errors = validateFunctionsConfig({
        enabled: true,
        auth: { type },
      });

      expect(errors).toEqual([
        {
          field: 'services.functions.auth.type',
          message:
            `Invalid services.functions.auth.type: found ${description}. ` +
            'Only application authentication is supported. ' +
            'Set services.functions.auth.type to "application".',
        },
      ]);
    }
  );

  it.each([
    { yaml: 'enabled', description: '"enabled"' },
    { yaml: '- enabled: true', description: 'a list' },
  ])('rejects a $description functions block', ({ yaml, description }) => {
    const config = parseRayfinYaml(
      ['id: app', 'services:', '  functions:', `    ${yaml}`].join('\n')
    );

    expect(validateFunctionsConfig(config.services.functions)).toEqual([
      {
        field: 'services.functions',
        message:
          `Invalid services.functions: expected a mapping, but found ${description}. ` +
          'Set services.functions to a mapping, for example: { enabled: false }.',
      },
    ]);
  });

  it('still treats an omitted functions block as disabled', () => {
    const config = parseRayfinYaml('id: app\nservices:\n  functions:');

    expect(config.services.functions).toEqual({ enabled: false });
    expect(validateFunctionsConfig(config.services.functions)).toEqual([]);
  });

  it.each([
    { enabled: true },
    { enabled: true, auth: {} },
    { enabled: true, auth: { type: 'delegated' } },
    { enabled: true, auth: { type: 'application' } },
  ])('does not mutate the authored configuration: %j', (functions) => {
    const original = structuredClone(functions);
    Object.freeze(functions.auth);
    Object.freeze(functions);

    validateFunctionsConfig(functions);

    expect(functions).toEqual(original);
  });

  it.each(['application', 'delegated', 'none'])(
    'validates the interpolated auth type %s without rewriting it',
    (type) => {
      const config = parseRayfinYamlInterpolated(
        `
id: test-app
services:
  functions:
    enabled: true
    auth:
      type: \${FUNCTIONS_AUTH_TYPE}
`,
        new Map([['FUNCTIONS_AUTH_TYPE', type]])
      );

      expect(config.services.functions?.auth?.type).toBe(type);
      expect(validateFunctionsConfig(config.services.functions)).toHaveLength(
        type === 'application' ? 0 : 1
      );
      expect(config.services.functions?.auth?.type).toBe(type);
    }
  );
});
