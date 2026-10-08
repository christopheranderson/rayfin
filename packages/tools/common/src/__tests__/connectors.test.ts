import { describe, it, expect } from 'vitest';

import {
  CONNECTOR_CATALOG,
  suggestConnectorType,
} from '../config/connectors.js';
import type { ConnectorType } from '../config/types.js';
import { KNOWN_CONNECTOR_TYPES } from '../config/validateConnectors.js';

describe('CONNECTOR_CATALOG', () => {
  it('should contain all five Fabric connector types', () => {
    expect(CONNECTOR_CATALOG).toHaveProperty('fabric-sqlanalytics');
    expect(CONNECTOR_CATALOG).toHaveProperty('fabric-warehouse');
    expect(CONNECTOR_CATALOG).toHaveProperty('fabric-sqldatabase');
    expect(CONNECTOR_CATALOG).toHaveProperty('fabric-semanticmodel');
    expect(CONNECTOR_CATALOG).toHaveProperty('kusto');
    expect(Object.keys(CONNECTOR_CATALOG)).toHaveLength(5);
  });

  it('should have descriptions for all connectors', () => {
    for (const [, meta] of Object.entries(CONNECTOR_CATALOG)) {
      expect(meta.description).toBeTruthy();
      expect(typeof meta.description).toBe('string');
    }
  });

  it('should require workspaceId and itemId for all connectors', () => {
    for (const [, meta] of Object.entries(CONNECTOR_CATALOG)) {
      expect(meta.requiredConfigArgs).toContain('workspaceId');
      expect(meta.requiredConfigArgs).toContain('itemId');
    }
  });

  it.each([
    'fabric-sqlanalytics',
    'fabric-warehouse',
    'fabric-sqldatabase',
  ] as const)(
    'defaults %s to application auth and still allows delegated auth',
    (type) => {
      expect(CONNECTOR_CATALOG[type].defaultAuth).toBe('application');
      expect(CONNECTOR_CATALOG[type].allowedAuthTypes).toContain('delegated');
    }
  );

  it.each(['fabric-semanticmodel', 'kusto'] as const)(
    'keeps %s defaulting to delegated auth',
    (type) => {
      expect(CONNECTOR_CATALOG[type].defaultAuth).toBe('delegated');
    }
  );

  it('allows the default auth type for every connector', () => {
    for (const [, meta] of Object.entries(CONNECTOR_CATALOG)) {
      expect(meta.allowedAuthTypes).toContain(meta.defaultAuth);
    }
  });

  it('assigns every connector type to a category', () => {
    expect(CONNECTOR_CATALOG['fabric-sqlanalytics'].category).toBe(
      'graphql-entities'
    );
    expect(CONNECTOR_CATALOG['fabric-warehouse'].category).toBe(
      'graphql-entities'
    );
    expect(CONNECTOR_CATALOG['fabric-sqldatabase'].category).toBe(
      'graphql-entities'
    );
    expect(CONNECTOR_CATALOG['fabric-semanticmodel'].category).toBe(
      'function-bridge'
    );
    expect(CONNECTOR_CATALOG.kusto.category).toBe('function-bridge');
  });

  it('names the packages the generated schema.ts imports for each type', () => {
    for (const [, meta] of Object.entries(CONNECTOR_CATALOG)) {
      expect(meta.clientPackages.length).toBeGreaterThan(0);
      expect(
        meta.clientPackages.filter((pkg) => pkg.role === 'marker')
      ).toHaveLength(1);
    }
    expect(
      CONNECTOR_CATALOG['fabric-warehouse'].clientPackages.map((p) => p.name)
    ).toEqual([
      '@microsoft/rayfin-connector-fabric-graphql',
      '@microsoft/rayfin-connectors',
    ]);
    // The Kusto scaffold imports its marker and `KustoConnectorConfig` from the
    // Kusto package, but the generated `src/lib/connectors.ts` also needs
    // `ConnectorConfig`/`ConnectorsRuntime` from `@microsoft/rayfin-connectors`,
    // so both are pinned.
    expect(CONNECTOR_CATALOG.kusto.clientPackages).toEqual([
      { name: '@microsoft/rayfin-connector-kusto', role: 'marker' },
      { name: '@microsoft/rayfin-connectors', role: 'runtime' },
    ]);
  });

  it('names the marker package a function-bridge type generates against', () => {
    for (const type of ['fabric-semanticmodel', 'kusto'] as const) {
      const meta = CONNECTOR_CATALOG[type];
      const marker = meta.clientPackages.find((pkg) => pkg.role === 'marker');
      expect(marker?.name).toBe(meta.schemaMarker?.package);
    }
  });

  it('should include explicit connector-to-dialect mapping', () => {
    expect(CONNECTOR_CATALOG['fabric-sqlanalytics'].dialect).toBe(
      'fabric-sqlanalytics'
    );
    expect(CONNECTOR_CATALOG['fabric-warehouse'].dialect).toBe(
      'fabric-warehouse'
    );
    expect(CONNECTOR_CATALOG['fabric-sqldatabase'].dialect).toBe('mssql');
    expect(CONNECTOR_CATALOG['fabric-semanticmodel'].dialect).toBeNull();
    expect(CONNECTOR_CATALOG.kusto.dialect).toBeNull();
  });

  it('allows CRUD operations on writable Cat-A Fabric connectors', () => {
    for (const type of ['fabric-warehouse', 'fabric-sqldatabase'] as const) {
      expect(CONNECTOR_CATALOG[type].allowedOperations).toEqual([
        'read',
        'create',
        'update',
        'delete',
      ]);
    }
  });

  it('restricts fabric-sqlanalytics (Lakehouse) to read-only', () => {
    expect(CONNECTOR_CATALOG['fabric-sqlanalytics'].allowedOperations).toEqual([
      'read',
    ]);
  });

  it('should allow only executeQuery on fabric-semanticmodel', () => {
    expect(CONNECTOR_CATALOG['fabric-semanticmodel'].allowedOperations).toEqual(
      ['executeQuery']
    );
  });

  it('allows executeQuery and executeCommand on kusto', () => {
    expect(CONNECTOR_CATALOG.kusto.allowedOperations).toEqual([
      'executeQuery',
      'executeCommand',
    ]);
  });

  it('should require version on Category B connectors', () => {
    expect(CONNECTOR_CATALOG['fabric-sqlanalytics'].requiresVersion).toBe(
      false
    );
    expect(CONNECTOR_CATALOG['fabric-warehouse'].requiresVersion).toBe(false);
    expect(CONNECTOR_CATALOG['fabric-sqldatabase'].requiresVersion).toBe(false);
    expect(CONNECTOR_CATALOG['fabric-semanticmodel'].requiresVersion).toBe(
      true
    );
    expect(CONNECTOR_CATALOG.kusto.requiresVersion).toBe(true);
    expect(CONNECTOR_CATALOG.kusto.defaultVersion).toBe('1');
  });

  it('should restrict Category B connectors to delegated auth', () => {
    expect(CONNECTOR_CATALOG['fabric-semanticmodel'].allowedAuthTypes).toEqual([
      'delegated',
    ]);
    expect(CONNECTOR_CATALOG.kusto.allowedAuthTypes).toEqual(['delegated']);
  });

  // `connector search` is how a Builder obtains the workspace and item GUIDs,
  // so a type that is addable but not searchable has no on-ramp. Kusto was
  // excluded for a year purely because the flag was omitted.
  it('makes every catalog type discoverable', () => {
    for (const [type, meta] of Object.entries(CONNECTOR_CATALOG)) {
      expect(
        meta.discoverable,
        `${type} must be searchable, or this test needs an explicit documented exception`
      ).toBe(true);
      expect(
        meta.fabricItemType,
        `${type} needs a Fabric item type`
      ).toBeTruthy();
    }
  });
});

describe('suggestConnectorType', () => {
  const ALL = Object.keys(CONNECTOR_CATALOG) as ConnectorType[];

  it('should suggest fabric-sqlanalytics for close misspelling', () => {
    expect(suggestConnectorType('fabric-sqlanalitics', ALL)).toBe(
      'fabric-sqlanalytics'
    );
  });

  it('should suggest fabric-warehouse for close misspelling', () => {
    expect(suggestConnectorType('fabric-warehose', ALL)).toBe(
      'fabric-warehouse'
    );
  });

  it('should suggest fabric-sqldatabase for close misspelling', () => {
    expect(suggestConnectorType('fabric-sqldatabse', ALL)).toBe(
      'fabric-sqldatabase'
    );
  });

  it('should return undefined for distant strings', () => {
    expect(suggestConnectorType('completely-different', ALL)).toBeUndefined();
  });

  it('should be case-insensitive', () => {
    expect(suggestConnectorType('FABRIC-SQLDATABASE', ALL)).toBe(
      'fabric-sqldatabase'
    );
  });

  it('never suggests a type the caller left out of the candidate list', () => {
    const authorable = ALL.filter((type) => type !== 'kusto');
    expect(suggestConnectorType('kusti', authorable)).toBeUndefined();
    expect(suggestConnectorType('kusti', ALL)).toBe('kusto');
  });
});

describe('connector authoring policy', () => {
  it('requires an authoring policy on every catalog entry', () => {
    for (const [type, meta] of Object.entries(CONNECTOR_CATALOG)) {
      expect(meta.authoring, `${type} needs an authoring policy`).toMatch(
        /^(released|held)$/
      );
    }
  });

  it('ships at least one connector type', () => {
    // `connector search` falls back to the authorable list when no --type is
    // given, and the discovery engines read an empty list as "no filter" and
    // enable every provider. A catalog where nothing is released would turn
    // that fallback into the leak the gate exists to prevent.
    const released = Object.values(CONNECTOR_CATALOG).filter(
      (meta) => meta.authoring === 'released'
    );
    expect(released.length).toBeGreaterThan(0);
  });

  it('holds kusto out of this release without dropping it from the catalog', () => {
    // The record has to stay complete: `validateConnectors` derives
    // KNOWN_CONNECTOR_TYPES from these keys, and `ConnectorType` is a
    // hand-written union the Kusto scaffold and services still reference.
    expect(CONNECTOR_CATALOG.kusto.authoring).toBe('held');
    expect(KNOWN_CONNECTOR_TYPES).toContain('kusto');
  });
});
