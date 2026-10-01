import { describe, expect, it } from 'vitest';

import {
  parseRayfinYaml,
  parseRayfinYamlInterpolated,
} from '../config/index.js';

const TODO_APP_YAML = `
id: todo-app
name: todo-app
version: 1.0.11
services:
  auth:
    enabled: true
    allowedRedirectUris:
      - http://localhost:5173
    customClaims:
      app_version: 1.0.0
    scopes:
      - read:data
      - write:data
    password:
      enabled: true
    passwordless:
      magicLink:
        enabled: true
        expiryMinutes: 15
  data:
    enabled: true
    dialect: postgresql
  storage:
    enabled: false
  staticHosting:
    enabled: true
    folder: dist
    buildCommand: npm run build
    indexDocument: index.html
`;

const MINIMAL_YAML = `
id: my-app
name: My App
version: 0.1.0
services:
  auth:
    enabled: false
  data:
    enabled: true
    dialect: mssql
  storage:
    enabled: false
`;

const INTERPOLATED_YAML = `
id: my-app
name: my-app
version: 1.0.0
services:
  auth:
    enabled: \${AUTH_ENABLED:-true}
  data:
    enabled: true
    dialect: mssql
  storage:
    enabled: false
`;

// ── parseRayfinYaml ─────────────────────────────────────────────────

describe('parseRayfinYaml', () => {
  it('parses a full todo-app config', () => {
    const config = parseRayfinYaml(TODO_APP_YAML);
    expect(config.id).toBe('todo-app');
    expect(config.name).toBe('todo-app');
    expect(config.version).toBe('1.0.11');
    expect(config.services.auth?.enabled).toBe(true);
    expect(config.services.auth?.scopes).toEqual(['read:data', 'write:data']);
    expect(config.services.auth?.password?.enabled).toBe(true);
    expect(config.services.auth?.passwordless?.magicLink?.enabled).toBe(true);
    expect(config.services.data?.enabled).toBe(true);
    expect(config.services.data?.dialect).toBe('postgresql');
    expect(config.services.storage?.enabled).toBe(false);
    expect(config.services.staticHosting?.enabled).toBe(true);
    expect(config.services.staticHosting?.folder).toBe('dist');
  });

  it('parses a minimal config and applies defaults', () => {
    const config = parseRayfinYaml(MINIMAL_YAML);
    expect(config.id).toBe('my-app');
    expect(config.services.auth?.enabled).toBe(false);
    expect(config.services.data?.dialect).toBe('mssql');
  });

  it('ignores unknown top-level sections gracefully', () => {
    const yaml = `
id: deployed-app
name: deployed-app
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
  storage:
    enabled: false
deployment:
  rayfinItemId: item-123
`;
    const config = parseRayfinYaml(yaml);
    expect(config.id).toBe('deployed-app');
    expect(config.services.data.enabled).toBe(true);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseRayfinYaml('{')).toThrow();
  });

  it('preserves optional service path fields when present', () => {
    const yaml = `
id: workspace-app
name: workspace-app
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
    dialect: mssql
    path: packages/data
  storage:
    enabled: false
    path: packages/data
  staticHosting:
    enabled: true
    path: packages/frontend
    folder: dist
  functions:
    enabled: true
    path: packages/functions
`;

    const config = parseRayfinYaml(yaml);
    expect(config.services.data.path).toBe('packages/data');
    expect(config.services.storage?.path).toBe('packages/data');
    expect(config.services.staticHosting?.path).toBe('packages/frontend');
    expect(config.services.functions?.path).toBe('packages/functions');
  });

  it('preserves data buildCommand when present', () => {
    const yaml = `
id: workspace-app
name: workspace-app
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
    dialect: mssql
    path: packages/data
    buildCommand: npm run build
  storage:
    enabled: false
  staticHosting:
    enabled: true
    folder: dist
    buildCommand: npm run build:fabric
`;

    const config = parseRayfinYaml(yaml);
    expect(config.services.data.buildCommand).toBe('npm run build');
    expect(config.services.staticHosting?.buildCommand).toBe(
      'npm run build:fabric'
    );
  });

  it('omits data buildCommand when absent', () => {
    const yaml = `
id: simple-app
name: simple-app
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: true
    dialect: mssql
  storage:
    enabled: false
`;

    const config = parseRayfinYaml(yaml);
    expect(config.services.data.buildCommand).toBeUndefined();
  });

  it('leaves auth unset when functions are disabled', () => {
    const config = parseRayfinYaml(MINIMAL_YAML);

    expect(config.services.functions?.enabled).toBe(false);
    expect(config.services.functions?.auth).toBeUndefined();
  });

  it('leaves an omitted functions auth block untouched when enabled', () => {
    const config = parseRayfinYaml(`${MINIMAL_YAML}
  functions:
    enabled: true
`);

    // Validation rejects the missing auth; parsing must not silently add it.
    expect(config.services.functions?.enabled).toBe(true);
    expect(config.services.functions?.auth).toBeUndefined();
  });

  it('preserves an explicit auth type on disabled functions', () => {
    const config = parseRayfinYaml(`${MINIMAL_YAML}
  functions:
    enabled: false
    auth:
      type: application
`);

    expect(config.services.functions?.auth?.type).toBe('application');
  });

  it('leaves a malformed auth block untouched for validation to reject', () => {
    const config = parseRayfinYaml(`${MINIMAL_YAML}
  functions:
    enabled: true
    auth: delegated
`);

    expect(config.services.functions?.auth).toBe('delegated');
  });

  it('leaves an omitted functions auth type untouched', () => {
    const config = parseRayfinYaml(`${MINIMAL_YAML}
  functions:
    enabled: true
    auth: {}
`);

    expect(config.services.functions?.auth).toEqual({});
    expect(config.services.functions?.auth?.type).toBeUndefined();
  });

  it.each(['delegated', 'application'] as const)(
    'preserves the authored functions auth type %s for validation',
    (type) => {
      const config = parseRayfinYaml(`${MINIMAL_YAML}
  functions:
    enabled: true
    auth:
      type: ${type}
`);

      expect(config.services.functions?.auth?.type).toBe(type);
    }
  );
});

// ── connectors normalization ────────────────────────────────────────

describe('parseRayfinYaml connectors normalization', () => {
  const baseYaml = `
id: x
name: x
version: 1.0.0
services:
  auth:
    enabled: false
  data:
    enabled: false
  storage:
    enabled: false
`;

  it('normalizes legacy map shape to array with name lifted', () => {
    const yaml =
      baseYaml +
      `connectors:
  inventory:
    connector: fabric-sqlanalytics
    config:
      workspaceId: ws-1
      itemId: item-1
`;
    const config = parseRayfinYaml(yaml);
    expect(Array.isArray(config.connectors)).toBe(true);
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors?.[0]).toMatchObject({
      name: 'inventory',
      type: 'fabric-sqlanalytics',
      config: { workspaceId: 'ws-1', itemId: 'item-1' },
    });
  });

  it('renames legacy per-entry `connector:` field to `type:` in array shape', () => {
    const yaml =
      baseYaml +
      `connectors:
  - name: inventory
    connector: fabric-sqldatabase
    config:
      workspaceId: ws-1
      itemId: item-1
`;
    const config = parseRayfinYaml(yaml);
    expect(config.connectors?.[0]).toMatchObject({
      name: 'inventory',
      type: 'fabric-sqldatabase',
    });
    expect(
      (config.connectors?.[0] as unknown as Record<string, unknown>).connector
    ).toBe(undefined);
  });

  it('passes new array+type shape through unchanged', () => {
    const yaml =
      baseYaml +
      `connectors:
  - name: orders
    type: fabric-warehouse
    auth:
      type: delegated
    config:
      workspaceId: ws-1
      itemId: item-1
`;
    const config = parseRayfinYaml(yaml);
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors?.[0]).toMatchObject({
      name: 'orders',
      type: 'fabric-warehouse',
      auth: { type: 'delegated' },
    });
  });

  it('leaves missing connectors block as undefined', () => {
    const config = parseRayfinYaml(baseYaml);
    expect(config.connectors).toBeUndefined();
  });
});

// ── parseRayfinYamlInterpolated ─────────────────────────────────────

describe('parseRayfinYamlInterpolated', () => {
  it('interpolates env vars with defaults', () => {
    const env = new Map<string, string>();
    const config = parseRayfinYamlInterpolated(INTERPOLATED_YAML, env);
    // AUTH_ENABLED not in env → default "true" → coerced to boolean true
    expect(config.services.auth?.enabled).toBe(true);
  });

  it('interpolates env vars from the map', () => {
    const env = new Map([['AUTH_ENABLED', 'false']]);
    const config = parseRayfinYamlInterpolated(INTERPOLATED_YAML, env);
    expect(config.services.auth?.enabled).toBe(false);
  });

  it('throws on missing var without default', () => {
    const yaml = `
id: test
name: test
version: 1.0.0
services:
  auth:
    enabled: \${REQUIRED_VAR}
  data:
    enabled: true
  storage:
    enabled: false
`;
    expect(() => parseRayfinYamlInterpolated(yaml, new Map())).toThrow(
      "Environment variable 'REQUIRED_VAR'"
    );
  });

  it.each(['delegated', 'application'] as const)(
    'preserves the interpolated functions auth type %s',
    (type) => {
      const yaml = `${INTERPOLATED_YAML}
  functions:
    enabled: true
    auth:
      type: \${FUNCTIONS_AUTH_TYPE}
`;

      const config = parseRayfinYamlInterpolated(
        yaml,
        new Map([['FUNCTIONS_AUTH_TYPE', type]])
      );

      expect(config.services.functions?.auth?.type).toBe(type);
    }
  );
});

// ── fabric brokered auth ────────────────────────────────────────────

describe('parseRayfinYaml fabric auth', () => {
  const baseYaml = (fabricBlock: string) => `
id: fabric-app
name: fabric-app
version: 1.0.0
services:
  auth:
    enabled: true
    fabric:
${fabricBlock}
  data:
    enabled: false
  storage:
    enabled: false
`;

  it('parses externalEntraExchange when set to true', () => {
    const config = parseRayfinYaml(
      baseYaml('      enabled: true\n      externalEntraExchange: true')
    );
    expect(config.services.auth.fabric?.enabled).toBe(true);
    expect(config.services.auth.fabric?.externalEntraExchange).toBe(true);
  });

  it('parses externalEntraExchange when set to false', () => {
    const config = parseRayfinYaml(
      baseYaml('      enabled: true\n      externalEntraExchange: false')
    );
    expect(config.services.auth.fabric?.externalEntraExchange).toBe(false);
  });

  it('leaves externalEntraExchange undefined when omitted (opt-in defaults off)', () => {
    const config = parseRayfinYaml(baseYaml('      enabled: true'));
    expect(config.services.auth.fabric?.enabled).toBe(true);
    expect(config.services.auth.fabric?.externalEntraExchange).toBeUndefined();
  });
});
