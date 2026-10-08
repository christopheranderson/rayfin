/**
 * Contract test for `rayfin connector types --json`.
 *
 * The payload is the catalog an agent reads instead of a hand-copied table, so
 * the shape is pinned here: any change that drops or renames a field fails.
 *
 * It lists the *authorable* types, not the whole catalog. A type held back for
 * this release stays in `CONNECTOR_CATALOG` so existing apps keep validating,
 * but must not be offered here.
 */

import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it, vi } from 'vitest';

import {
  connectorTypesCommand,
  CONNECTOR_TYPES_SCHEMA_VERSION,
} from '../connector-types.js';

/** Catalog types that ship in this release, sorted the way the command emits. */
const RELEASED_TYPES = Object.entries(CONNECTOR_CATALOG)
  .filter(([, meta]) => meta.authoring === 'released')
  .map(([type]) => type)
  .sort((a, b) => a.localeCompare(b));

const HELD_TYPES = Object.entries(CONNECTOR_CATALOG)
  .filter(([, meta]) => meta.authoring === 'held')
  .map(([type]) => type);

interface PackageRow {
  name: string;
  role: string;
  version: string;
}

interface TypeRow {
  type: string;
  category: string;
  description: string;
  defaultAuth: string;
  allowedAuthTypes: string[];
  dialect: string | null;
  allowedOperations: string[];
  requiredConfig: string[];
  discoverableItemTypes: string[];
  requiresVersion: boolean;
  defaultVersion?: string;
  packages: PackageRow[];
}

interface Payload {
  status: string;
  schemaVersion: number;
  count: number;
  types: TypeRow[];
}

function runJson(): Payload {
  const chunks: string[] = [];
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    connectorTypesCommand.parse(['--json'], { from: 'user' });
  } finally {
    write.mockRestore();
  }
  return JSON.parse(chunks.join('')) as Payload;
}

describe('connector types --json', () => {
  it('emits a single parseable object carrying the schema version', () => {
    const payload = runJson();
    expect(payload.status).toBe('ok');
    expect(payload.schemaVersion).toBe(CONNECTOR_TYPES_SCHEMA_VERSION);
    expect(payload.count).toBe(payload.types.length);
    expect(payload.count).toBe(RELEASED_TYPES.length);
  });

  it('emits every released type sorted, with the full field set', () => {
    const payload = runJson();
    expect(payload.types.map((row) => row.type)).toEqual(RELEASED_TYPES);
    for (const row of payload.types) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'allowedAuthTypes',
          'allowedOperations',
          'category',
          'defaultAuth',
          ...(row.requiresVersion ? ['defaultVersion'] : []),
          'description',
          'dialect',
          'discoverableItemTypes',
          'packages',
          'requiredConfig',
          'requiresVersion',
          'type',
        ].sort()
      );
      expect(['graphql-entities', 'function-bridge']).toContain(row.category);
      expect(row.requiredConfig).toEqual(['workspaceId', 'itemId']);
    }
  });

  it('reports application auth for Category A and delegated auth for Category B', () => {
    const payload = runJson();
    expect(
      Object.fromEntries(
        payload.types.map((row) => [row.type, row.defaultAuth])
      )
    ).toEqual({
      'fabric-sqlanalytics': 'application',
      'fabric-warehouse': 'application',
      'fabric-sqldatabase': 'application',
      'fabric-semanticmodel': 'delegated',
    });
  });

  it('carries package metadata an agent can install from directly', () => {
    const payload = runJson();
    for (const row of payload.types) {
      expect(row.packages.length).toBeGreaterThan(0);
      for (const pkg of row.packages) {
        expect(pkg.name.startsWith('@microsoft/')).toBe(true);
        expect(['marker', 'runtime']).toContain(pkg.role);
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/u);
      }
    }
    const semanticModel = payload.types.find(
      (row) => row.type === 'fabric-semanticmodel'
    );
    expect(semanticModel?.packages.map((pkg) => pkg.name)).toEqual([
      '@microsoft/rayfin-connector-fabric-semanticmodel',
      '@microsoft/rayfin-connectors',
    ]);
  });

  it('omits a type held back for this release', () => {
    // Guards the leak this gate exists to close: an agent reads `types` to
    // learn what it can add, so a held type here would be advertised as
    // available and then rejected by `add`.
    const payload = runJson();
    for (const held of HELD_TYPES) {
      expect(payload.types.map((row) => row.type)).not.toContain(held);
    }
    expect(HELD_TYPES).toContain('kusto');
  });
});
