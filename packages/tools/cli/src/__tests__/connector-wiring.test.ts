import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { ConnectorEntry } from '@microsoft/rayfin-tools-common/_internal/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lets a single test simulate a read-only or locked `src/lib/connectors.ts`.
 * Everything else runs against the real filesystem in a temp dir.
 */
const fsControl = vi.hoisted(() => ({ failWrites: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.failWrites) {
        throw new Error('EACCES: permission denied, open');
      }
      return actual.writeFileSync(...args);
    },
  };
});

import {
  APP_WIRING_RELATIVE,
  extractAppOwnedPrologue,
  regenerateConnectorWiring,
  renderAppWiring,
  reportConnectorWiring,
} from '../services/connector-wiring';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-connector-wiring-'));
});

afterEach(() => {
  fsControl.failWrites = false;
  rmSync(projectRoot, { recursive: true, force: true });
});

/** The pristine `src/lib/connectors.ts` the Lyra template ships. */
const PRISTINE_WIRING = `import type {
  ConnectorConfig,
  ConnectorsRuntime,
} from '@microsoft/rayfin-connectors';

export const connectorConfigs: Record<string, ConnectorConfig> = {};
export const connectorRuntimes: ConnectorsRuntime = {};
`;

function seedAppWiring(contents: string = PRISTINE_WIRING): string {
  const appPath = join(projectRoot, 'src', 'lib', 'connectors.ts');
  mkdirSync(join(projectRoot, 'src', 'lib'), { recursive: true });
  writeFileSync(appPath, contents);
  return appPath;
}

function seedWorkspaceAppWiring(contents: string = PRISTINE_WIRING): string {
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] })
  );
  const packageDir = join(projectRoot, 'packages', 'frontend');
  mkdirSync(join(packageDir, 'src', 'lib'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@rayfin-app/frontend',
      dependencies: { '@microsoft/rayfin-connectors': '^1.0.0' },
    })
  );
  const appPath = join(packageDir, 'src', 'lib', 'connectors.ts');
  writeFileSync(appPath, contents);
  return appPath;
}

/** Function-bridge scaffolds export `connectorConfig` straight away. */
function seedSchema(name: string, contents?: string): void {
  const dir = join(projectRoot, 'rayfin', 'connectors', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'schema.ts'),
    contents ??
      `export type ${name
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(
          ''
        )}Schema = { executeQuery(input: { query: string }): Promise<unknown> };\n` +
        `export const connectorConfig = { name: '${name}' };\n`
  );
}

function entry(name: string, type: string): ConnectorEntry {
  return { name, type } as ConnectorEntry;
}

describe('regenerateConnectorWiring', () => {
  it('wires the connector-owning workspace package with a relative schema import', () => {
    const appPath = seedWorkspaceAppWiring();
    seedSchema('store-sales');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('written');
    expect(result.wiringPath).toBe('packages/frontend/src/lib/connectors.ts');
    expect(readFileSync(appPath, 'utf-8')).toContain(
      "from '../../../../rayfin/connectors/store-sales/schema';"
    );
  });

  it('preserves a valid custom AppConnectorsSchema mapping', () => {
    const appPath = seedAppWiring(`import type {
  ConnectorConfig,
  ConnectorsRuntime,
} from '@microsoft/rayfin-connectors';
import type { CatalogSchema } from '../../rayfin/connectors/inventory/schema';

export type AppConnectorsSchema = {
  inventory: CatalogSchema;
};

export const connectorConfigs: Record<string, ConnectorConfig> = {};
export const connectorRuntimes: ConnectorsRuntime = {};
`);
    seedSchema(
      'inventory',
      `export type CatalogSchema = { list(): Promise<unknown> };\n` +
        `export const connectorConfig = { name: 'inventory' };\n`
    );

    const first = regenerateConnectorWiring(projectRoot, [
      entry('inventory', 'fabric-semanticmodel'),
    ]);
    const written = readFileSync(appPath, 'utf-8');

    expect(first.action).toBe('written');
    expect(written).toContain(
      "import type { CatalogSchema } from '../../rayfin/connectors/inventory/schema';"
    );
    expect(written).toContain('import { connectorConfig as inventoryConfig }');
    expect(written).toContain("'inventory': CatalogSchema;");
    expect(written).not.toContain('InventorySchema');
    expect(
      regenerateConnectorWiring(projectRoot, [
        entry('inventory', 'fabric-semanticmodel'),
      ]).action
    ).toBe('unchanged');
  });

  it('leaves wiring unchanged when the schema type export is ambiguous', () => {
    const appPath = seedAppWiring();
    const original = readFileSync(appPath, 'utf-8');
    seedSchema(
      'inventory',
      `export type CatalogSchema = { list(): Promise<unknown> };\n` +
        `export interface CatalogMetadata { version: string }\n` +
        `export const connectorConfig = { name: 'inventory' };\n`
    );

    const result = regenerateConnectorWiring(projectRoot, [
      entry('inventory', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('manual');
    expect(result.skipped[0]?.reason).toContain(
      'does not export an unambiguous connector schema type'
    );
    expect(readFileSync(appPath, 'utf-8')).toBe(original);
  });

  it('wires a semantic-model connector into a pristine template file', () => {
    const appPath = seedAppWiring();
    seedSchema('store-sales');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('written');
    expect(result.wired).toEqual(['store-sales']);
    expect(result.runtimes).toEqual(['store-sales']);
    expect(result.skipped).toEqual([]);

    const written = readFileSync(appPath, 'utf-8');
    expect(written).toContain(
      "import { connectorConfig as storeSalesConfig, type StoreSalesSchema as storeSalesSchema } from '../../rayfin/connectors/store-sales/schema';"
    );
    expect(written).toContain('type StoreSalesSchema as storeSalesSchema');
    expect(written).toContain("'store-sales': storeSalesSchema;");
    expect(written).toContain(
      "import { fabricSemanticModel } from '@microsoft/rayfin-connector-fabric-semanticmodel';"
    );
    expect(written).toContain("'store-sales': storeSalesConfig,");
    // Factories take no arguments; the target is injected server-side.
    expect(written).toContain("'store-sales': fabricSemanticModel(),");
  });

  it('reports unchanged when regenerated twice with the same inputs', () => {
    seedAppWiring();
    seedSchema('store-sales');
    const connectors = [entry('store-sales', 'fabric-semanticmodel')];

    expect(regenerateConnectorWiring(projectRoot, connectors).action).toBe(
      'written'
    );
    expect(regenerateConnectorWiring(projectRoot, connectors).action).toBe(
      'unchanged'
    );
  });

  it('drops a connector from the wiring once it is removed from rayfin.yml', () => {
    const appPath = seedAppWiring();
    seedSchema('store-sales');
    seedSchema('inventory');

    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
      entry('inventory', 'fabric-semanticmodel'),
    ]);

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('written');
    expect(result.wired).toEqual(['store-sales']);
    const written = readFileSync(appPath, 'utf-8');
    expect(written).toContain('store-sales');
    expect(written).not.toContain('inventory');
  });

  it('never clobbers a Builder-owned file and returns the exact snippet', () => {
    const handEdited = `import type { ConnectorConfig, ConnectorsRuntime } from '@microsoft/rayfin-connectors';
import { connectorConfig as mine } from '../../rayfin/connectors/mine/schema';

export const connectorConfigs: Record<string, ConnectorConfig> = { mine };
export const connectorRuntimes: ConnectorsRuntime = {};
`;
    const appPath = seedAppWiring(handEdited);
    seedSchema('store-sales');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('manual');
    expect(result.snippet).toContain("'store-sales': storeSalesConfig,");
    expect(readFileSync(appPath, 'utf-8')).toBe(handEdited);
  });

  it('takes ownership back once the generated marker is present', () => {
    seedAppWiring();
    seedSchema('store-sales');
    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    // Second connector: file now carries the marker but no longer matches the
    // empty-map shape, so the marker alone must keep it rewritable.
    seedSchema('inventory');
    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
      entry('inventory', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('written');
    expect(result.wired).toEqual(['store-sales', 'inventory']);
  });

  it('reports absent for a project without src/lib/connectors.ts', () => {
    seedSchema('store-sales');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('absent');
    // The plan is still computed so callers can report what would be wired.
    expect(result.wired).toEqual(['store-sales']);
  });

  it('skips a SQL-style placeholder schema that has no connectorConfig export', () => {
    seedAppWiring();
    seedSchema('salesdb', 'export const schema = [];\n');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('salesdb', 'fabric-sqldatabase'),
    ]);

    expect(result.wired).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe('salesdb');
    expect(result.skipped[0].reason).toMatch(/does not export/);
  });

  /**
   * Regression for the unanchored `CONFIG_EXPORT_PATTERN`: a commented-out
   * export used to read as a real one, so we generated an import for a binding
   * that does not exist and the app failed to build.
   */
  it('skips a schema whose connectorConfig export is commented out', () => {
    seedAppWiring();
    seedSchema(
      'store-sales',
      '// export const connectorConfig = { name: "store-sales" };\n'
    );

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.wired).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe('store-sales');
    expect(result.skipped[0].reason).toMatch(/does not export/);
  });

  /**
   * Same regression, string-literal flavour: an export mentioned inside a
   * template or error message is not a real export.
   */
  it('skips a schema that only mentions the export inside a string', () => {
    seedAppWiring();
    seedSchema(
      'store-sales',
      "const hint = 'export const connectorConfig = {}';\nexport const schema = [hint];\n"
    );

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.wired).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/does not export/);
  });

  /**
   * `rayfin.yml` is hand-editable, so a name from it can reach file paths,
   * import specifiers, and quoted map keys. Reject it before any of that.
   */
  it('skips a connector whose rayfin.yml name is not a valid identifier', () => {
    const appPath = seedAppWiring();
    seedSchema('store-sales');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('../../etc/passwd', 'fabric-semanticmodel'),
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.wired).toEqual(['store-sales']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe('../../etc/passwd');
    expect(result.skipped[0].reason).toMatch(/not a valid connector name/);

    const written = readFileSync(appPath, 'utf-8');
    expect(written).not.toContain('etc/passwd');
  });

  it('skips a connector whose schema.ts has not been scaffolded', () => {
    seedAppWiring();

    const result = regenerateConnectorWiring(projectRoot, [
      entry('ghost', 'fabric-semanticmodel'),
    ]);

    expect(result.wired).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/is missing/);
  });

  it('wires a connector with no runtime factory into configs only', () => {
    const appPath = seedAppWiring();
    seedSchema('telemetry');

    // `lakehouse` is one of the catalog entries that genuinely has no runtime
    // factory — it returns JSON and needs no request-path injection.
    const result = regenerateConnectorWiring(projectRoot, [
      entry('telemetry', 'lakehouse'),
    ]);

    expect(result.wired).toEqual(['telemetry']);
    expect(result.runtimes).toEqual([]);

    const written = readFileSync(appPath, 'utf-8');
    expect(written).toContain("'telemetry': telemetryConfig,");
    expect(written).toContain(
      'export const connectorRuntimes: ConnectorsRuntime = {};'
    );
    expect(written).toContain('default JSON pass-through');
  });

  it('suffixes aliases that collide after punctuation is stripped', () => {
    const appPath = seedAppWiring();
    seedSchema('store-sales');
    seedSchema('store_sales');

    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
      entry('store_sales', 'fabric-semanticmodel'),
    ]);

    const written = readFileSync(appPath, 'utf-8');
    expect(written).toContain("'store-sales': storeSalesConfig,");
    expect(written).toContain("'store_sales': storeSalesConfig2,");
    expect(written).toContain("'store-sales': storeSalesSchema;");
    expect(written).toContain("'store_sales': storeSalesSchema2;");
  });

  it('restarts each collision suffix from the base alias', () => {
    const appPath = seedAppWiring();
    seedSchema('store-sales');
    seedSchema('store_sales');
    seedSchema('store--sales');

    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
      entry('store_sales', 'fabric-semanticmodel'),
      entry('store--sales', 'fabric-semanticmodel'),
    ]);

    const written = readFileSync(appPath, 'utf-8');
    expect(written).toContain("'store-sales': storeSalesConfig,");
    expect(written).toContain("'store_sales': storeSalesConfig2,");
    // Suffixing must derive from the base alias, not the already-suffixed one,
    // or the third collision lands on `storeSalesConfig23`.
    expect(written).toContain("'store--sales': storeSalesConfig3,");
    expect(written).not.toContain('storeSalesConfig23');
  });

  it('falls back to a manual snippet when the app file cannot be written', () => {
    const appPath = seedAppWiring();
    seedSchema('store-sales');
    const before = readFileSync(appPath, 'utf-8');

    fsControl.failWrites = true;
    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('manual');
    expect(result.snippet).toBeTruthy();
    expect(result.snippet).toContain("'store-sales': storeSalesConfig,");
    expect(readFileSync(appPath, 'utf-8')).toBe(before);
  });
});

describe('renderAppWiring', () => {
  it('emits empty maps when nothing is wireable', () => {
    const rendered = renderAppWiring([]);

    expect(rendered).toContain(
      'export const connectorConfigs: Record<string, ConnectorConfig> = {};'
    );
    expect(rendered).toContain(
      'export const connectorRuntimes: ConnectorsRuntime = {};'
    );
  });

  it('marks generated output and documents the opt-out', () => {
    const rendered = renderAppWiring([]);

    expect(rendered).toContain('@generated by `rayfin connector add`');
    expect(rendered).toContain('delete the');
  });

  it('imports each runtime package exactly once', () => {
    const rendered = renderAppWiring([
      {
        name: 'a',
        configAlias: 'aConfig',
        runtime: {
          factory: 'fabricSemanticModel',
          package: '@microsoft/rayfin-connector-fabric-semanticmodel',
        },
      },
      {
        name: 'b',
        configAlias: 'bConfig',
        runtime: {
          factory: 'fabricSemanticModel',
          package: '@microsoft/rayfin-connector-fabric-semanticmodel',
        },
      },
    ]);

    const imports = rendered
      .split('\n')
      .filter((l) => l.includes('rayfin-connector-fabric-semanticmodel'));
    expect(imports).toHaveLength(1);
  });
});

describe('APP_WIRING_RELATIVE', () => {
  it('points at the file the app actually reads', () => {
    expect(APP_WIRING_RELATIVE).toBe('src/lib/connectors.ts');
  });
});

/**
 * The pristine `src/lib/connectors.ts` shipped by the Lyra basic-data-app
 * template (powerbi-lyra#489). Regeneration must not eat the copyright header,
 * the copyright header or its imports. `AppConnectorsSchema` is regenerated
 * from the actual connector schema exports so connector names stay typed.
 */
const LYRA_WIRING = `//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ConnectorConfig, ConnectorsRuntime } from "@microsoft/rayfin-connectors";
import type { FabricSemanticModel } from "@microsoft/rayfin-connector-fabric-semanticmodel";

/**
 * Connectors this app can talk to, keyed by the connector name declared in
 * \`rayfin.yml\` under \`connectors.<name>\`.
 *
 * The index signature keeps every name usable without editing this file each
 * time you run \`rayfin connector add\`. Narrow it to the names you actually
 * use if you want the compiler to catch a typo in a connection alias:
 *
 * @example
 * export type AppConnectorsSchema = {
 *     salesModel: FabricSemanticModel<"executeQuery">;
 * };
 */
export type AppConnectorsSchema = Record<string, FabricSemanticModel<"executeQuery">>;

/**
 * Routing config for each connector, keyed by the same name used above.
 *
 * \`rayfin connector add\` writes a \`connectorConfig\` constant into
 * \`rayfin/connectors/<name>/schema.ts\`. Re-export that constant here instead of
 * hand-writing the object, so this file cannot drift from \`rayfin.yml\`.
 *
 * @example
 * import { connectorConfig as salesModel } from "../../rayfin/connectors/salesModel/schema";
 *
 * export const connectorConfigs: Record<string, ConnectorConfig> = { salesModel };
 */
export const connectorConfigs: Record<string, ConnectorConfig> = {};

/**
 * Per-connector runtime hooks, keyed by the same name again.
 *
 * \`fabric-semanticmodel\` returns an Apache Arrow stream and picks its transport
 * based on where the app is running, and both of those live in the runtime — so
 * a connector left out of this map falls back to the plain JSON pass-through and
 * will not decode. Register one runtime per semantic model; the connectors layer
 * already keys instances by name.
 *
 * @example
 * import { fabricSemanticModel } from "@microsoft/rayfin-connector-fabric-semanticmodel";
 *
 * export const connectorRuntimes: ConnectorsRuntime = {
 *     salesModel: fabricSemanticModel({}),
 * };
 *
 * @remarks
 * Do not pass a \`target\`. The workspace and item ids come from \`rayfin.yml\` and
 * are injected by the host, so the app never needs to know them. Deriving one
 * from a \`VITE_*\` variable throws at module load, because \`rayfin env\` emits a
 * fixed set of variables and a per-model URL is not among them.
 */
export const connectorRuntimes: ConnectorsRuntime = {};
`;

describe('app-owned prologue preservation', () => {
  it('extracts the prologue from a pristine template and drops the trailing doc comment', () => {
    const prologue = extractAppOwnedPrologue(LYRA_WIRING);

    expect(prologue).toContain('<copyright company="Microsoft Corporation">');
    expect(prologue).not.toContain('export type AppConnectorsSchema');
    expect(prologue).not.toContain('import type { FabricSemanticModel }');
    // The connectorConfigs doc comment sits directly above the generated
    // section, so it belongs to the generated half, not the prologue.
    expect(prologue).not.toContain('Routing config for each connector');
    expect(prologue.endsWith('*/')).toBe(false);
  });

  it('removes the complete multi-property connector schema declaration', () => {
    const prologue =
      extractAppOwnedPrologue(`import type { ConnectorConfig } from '@microsoft/rayfin-connectors';

/** Generated from the configured connectors. */
export type AppConnectorsSchema = {
  sales: SalesSchema;
  inventory: InventorySchema;
};

export const connectorConfigs: Record<string, ConnectorConfig> = {};
`);

    expect(prologue).toBe(
      "import type { ConnectorConfig } from '@microsoft/rayfin-connectors';"
    );
  });

  it('keeps the app-authored prologue when wiring a connector', () => {
    const appPath = seedAppWiring(LYRA_WIRING);
    seedSchema('store-sales');

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('written');

    const contents = readFileSync(appPath, 'utf-8');
    expect(contents.startsWith('// #region rayfin:app-owned')).toBe(true);
    expect(contents).toContain('<copyright company="Microsoft Corporation">');
    expect(contents).toContain('export type AppConnectorsSchema');
    expect(contents).toContain("'store-sales': storeSalesSchema;");
    expect(contents).not.toContain('import type { FabricSemanticModel }');
    expect(contents).toContain('// #endregion rayfin:app-owned');
    expect(contents).toContain(
      'connectorConfigs: Record<string, ConnectorConfig> = {'
    );
    expect(contents).toContain("'store-sales': storeSalesConfig");
    expect(contents).toContain("'store-sales': fabricSemanticModel()");
  });

  it('does not re-import bindings the prologue already imports', () => {
    const appPath = seedAppWiring(LYRA_WIRING);
    seedSchema('store-sales');

    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    const contents = readFileSync(appPath, 'utf-8');
    // The prologue mentions ConnectorConfig inside a JSDoc @example too, so
    // count import statements rather than raw token occurrences.
    const configImports = contents
      .split('\n')
      .filter((line) => /^import type \{[^}]*\bConnectorConfig\b/.test(line));
    expect(configImports).toHaveLength(1);

    const runtimeImports = contents
      .split('\n')
      .filter((line) => /^import type \{[^}]*\bConnectorsRuntime\b/.test(line));
    expect(runtimeImports).toHaveLength(1);
  });

  it('is idempotent across repeated runs', () => {
    const appPath = seedAppWiring(LYRA_WIRING);
    seedSchema('store-sales');

    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);
    const first = readFileSync(appPath, 'utf-8');

    const second = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(second.action).toBe('unchanged');
    expect(readFileSync(appPath, 'utf-8')).toBe(first);
  });

  it('drops a removed connector import while keeping the prologue', () => {
    const appPath = seedAppWiring(LYRA_WIRING);
    seedSchema('store-sales');
    seedSchema('web-sales');

    regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
      entry('web-sales', 'fabric-semanticmodel'),
    ]);
    expect(readFileSync(appPath, 'utf-8')).toContain(
      'rayfin/connectors/web-sales/schema'
    );

    const result = regenerateConnectorWiring(projectRoot, [
      entry('store-sales', 'fabric-semanticmodel'),
    ]);

    expect(result.action).toBe('written');

    const contents = readFileSync(appPath, 'utf-8');
    expect(contents).not.toContain('rayfin/connectors/web-sales/schema');
    expect(contents).not.toContain("'web-sales'");
    expect(contents).toContain('rayfin/connectors/store-sales/schema');
    expect(contents).toContain('export type AppConnectorsSchema');
    expect(contents).toContain('<copyright company="Microsoft Corporation">');
  });

  it('keeps the prologue when there is nothing to wire', () => {
    const appPath = seedAppWiring(LYRA_WIRING);

    const result = regenerateConnectorWiring(projectRoot, [
      entry('orders-db', 'postgresql'),
    ]);

    expect(result.wired).toHaveLength(0);

    const contents = readFileSync(appPath, 'utf-8');
    expect(contents).toContain('export type AppConnectorsSchema');
    expect(contents).toContain('<copyright company="Microsoft Corporation">');
    expect(contents).toContain(
      'connectorConfigs: Record<string, ConnectorConfig> = {}'
    );
    expect(contents).toContain('connectorRuntimes: ConnectorsRuntime = {}');
  });

  it('renders without a fence when no prologue is supplied', () => {
    const rendered = renderAppWiring([]);

    expect(rendered).not.toContain('#region rayfin:app-owned');
  });
});

describe('reportConnectorWiring', () => {
  /**
   * The first-class `dataapp` template has no src/lib/connectors.ts, so every
   * scaffolded project takes the `absent` branch. Gating that behind --verbose
   * reproduced the original bug: `connector add` reports success while the app
   * is left unwired.
   */
  it('always reports absent, even without --verbose', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      reportConnectorWiring(
        'plain',
        { wired: ['store-sales'], skipped: [], runtimes: [], action: 'absent' },
        false
      );

      const output = warn.mock.calls
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(output).toContain(APP_WIRING_RELATIVE);
      expect(output).toContain('nothing was wired');
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * `absent` means the file does not exist, so per-connector "is not wired into
   * src/lib/connectors.ts" warnings are noise that contradicts the headline
   * message. Only the single "nothing was wired" explanation should print.
   */
  it('suppresses per-connector skip warnings when the file is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      reportConnectorWiring(
        'plain',
        {
          wired: [],
          skipped: [
            {
              name: 'telemetry-db',
              reason: 'schema.ts does not export `connectorConfig` yet.',
            },
          ],
          runtimes: [],
          action: 'absent',
        },
        false
      );

      const output = warn.mock.calls
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(output).toContain('nothing was wired');
      expect(output).not.toContain('telemetry-db');
    } finally {
      warn.mockRestore();
    }
  });
});
