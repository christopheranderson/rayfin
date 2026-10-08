import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  type ConnectorEntry,
  type ConnectorType,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  isRayfinEntity: vi.fn(),
  analyzeEntities: vi.fn(),
  generateConfig: vi.fn(),
}));

vi.mock('@microsoft/rayfin-core/analysis', () => ({
  ConnectorConfigGenerator: class {
    generateConfig(...args: unknown[]) {
      return coreMocks.generateConfig(...args);
    }
  },
  ConnectorSchemaAnalyzer: class {
    analyzeEntities(...args: unknown[]) {
      return coreMocks.analyzeEntities(...args);
    }
  },
}));
vi.mock('@microsoft/rayfin-core/schema', () => ({
  isRayfinEntity: (...args: unknown[]) => coreMocks.isRayfinEntity(...args),
}));
vi.mock('../../utils/typescript-compiler.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/typescript-compiler.js')>();
  return {
    ...actual,
    compileRayfinDirectory: vi.fn(async () => ({
      success: true,
      errors: [],
    })),
  };
});

import {
  compileRayfinDirectory,
  RAYFIN_COMPILED_DIR,
} from '../../utils/typescript-compiler.js';
import { generateConnectorDabConfigs } from '../connector-generator.js';

function connector(type: ConnectorType): ConnectorEntry {
  return {
    name: 'inventory',
    type,
    config: { workspaceId: 'source-ws', itemId: 'source-item' },
    auth: { type: 'delegated' },
  };
}

describe('generateConnectorDabConfigs', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-connector-generator-'));
    mkdirSync(join(projectRoot, 'rayfin'), { recursive: true });
    coreMocks.isRayfinEntity.mockReturnValue(false);
    coreMocks.analyzeEntities.mockReturnValue([]);
    coreMocks.generateConfig.mockReturnValue({});
    vi.mocked(compileRayfinDirectory).mockResolvedValue({
      success: true,
      errors: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('preserves TypeScript diagnostics when compilation fails', async () => {
    vi.mocked(compileRayfinDirectory).mockResolvedValueOnce({
      success: false,
      errors: [
        '',
        'rayfin/connectors/inventory/Entity.ts(7,3): error TS2322: Type mismatch.',
        '  ',
      ],
    });

    await expect(
      generateConnectorDabConfigs({
        projectRoot,
        connectors: [connector('fabric-sqldatabase')],
        mode: 'silent',
      })
    ).rejects.toThrow(
      [
        'TypeScript compilation failed:',
        'rayfin/connectors/inventory/Entity.ts(7,3): error TS2322: Type mismatch.',
      ].join('\n')
    );
  });

  it('reports a Category A connector with no emitted JavaScript as an actionable error', async () => {
    const result = await generateConnectorDabConfigs({
      projectRoot,
      connectors: [connector('fabric-sqldatabase')],
      mode: 'silent',
    });

    expect(compileRayfinDirectory).toHaveBeenCalledTimes(1);
    expect(result.generated).toEqual([]);
    expect(result.results).toEqual([
      {
        name: 'inventory',
        connector: 'fabric-sqldatabase',
        status: 'error',
        error: expect.stringMatching(
          /No usable compiled connector entities.*rayfin\/\.temp\/compiled\/connectors\/inventory.*rayfin\/tsconfig\.json.*@entity\(\)/u
        ),
      },
    ]);
  });

  it('reports emitted JavaScript without entity exports as an actionable error', async () => {
    const compiledDir = join(
      projectRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'connectors',
      'inventory'
    );
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(
      join(compiledDir, 'not-an-entity.js'),
      'export const value = 1;\n'
    );

    const result = await generateConnectorDabConfigs({
      projectRoot,
      connectors: [connector('fabric-sqldatabase')],
      mode: 'silent',
    });

    expect(result.generated).toEqual([]);
    expect(result.results[0]).toMatchObject({
      name: 'inventory',
      connector: 'fabric-sqldatabase',
      status: 'error',
    });
    expect(result.results[0]?.error).toContain(
      'each source exports at least one @entity() class'
    );
  });

  it('generates config from a usable compiled entity export', async () => {
    const compiledDir = join(
      projectRoot,
      'rayfin',
      RAYFIN_COMPILED_DIR,
      'connectors',
      'inventory'
    );
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(
      join(compiledDir, 'Inventory.js'),
      'export class Inventory {}\n'
    );
    coreMocks.isRayfinEntity.mockImplementation(
      (value) => typeof value === 'function' && value.name === 'Inventory'
    );
    coreMocks.analyzeEntities.mockReturnValue([{ name: 'Inventory' }]);
    coreMocks.generateConfig.mockReturnValue({
      entities: { Inventory: { source: 'dbo.Inventory' } },
    });

    const result = await generateConnectorDabConfigs({
      projectRoot,
      connectors: [connector('fabric-sqldatabase')],
      mode: 'silent',
    });

    const configPath = join(
      projectRoot,
      'rayfin',
      '.temp',
      'connectors',
      'inventory',
      'dab-config.json'
    );
    expect(result.generated).toEqual(['inventory']);
    expect(result.results).toEqual([
      {
        name: 'inventory',
        connector: 'fabric-sqldatabase',
        status: 'generated',
        configPath,
      },
    ]);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      entities: { Inventory: { source: 'dbo.Inventory' } },
    });
  });

  it('preserves the intentional Category B no-dialect skip', async () => {
    const result = await generateConnectorDabConfigs({
      projectRoot,
      connectors: [connector('fabric-semanticmodel')],
      mode: 'silent',
    });

    expect(result.generated).toEqual([]);
    expect(result.results).toEqual([
      {
        name: 'inventory',
        connector: 'fabric-semanticmodel',
        status: 'skipped',
        reason: "connector type 'fabric-semanticmodel' has no dialect (Cat-B)",
      },
    ]);
  });
});
