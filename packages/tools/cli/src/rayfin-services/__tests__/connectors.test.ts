import {
  CONNECTOR_CONFIG_SKIP_REASON,
  type ApplyConnectorConfigsRequest,
} from '@microsoft/rayfin-tools-common/_internal/services/connectors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@microsoft/rayfin-core/analysis', () => ({
  describeReservedEntityName: vi.fn(),
  getReservedEntityNameReason: vi.fn(),
  RESERVED_ENTITY_NAMES: [],
}));
vi.mock('../../services/connector-generator.js', () => ({
  generateConnectorDabConfigs: vi.fn(),
}));
vi.mock('../../utils/connector-apply.js', async (importOriginal) => {
  // Keep the pure gate and formatting logic; mock filesystem collision
  // detection and the network-bound apply call.
  const actual =
    await importOriginal<typeof import('../../utils/connector-apply.js')>();
  return {
    ...actual,
    applyConnectorConfigs: vi.fn(),
    detectConnectorEntityCollisions: vi.fn(),
  };
});

import { generateConnectorDabConfigs } from '../../services/connector-generator.js';
import {
  applyConnectorConfigs,
  detectConnectorEntityCollisions,
} from '../../utils/connector-apply.js';
import { createCliConnectorService } from '../connectors.js';

const mockGenerate = generateConnectorDabConfigs as ReturnType<typeof vi.fn>;
const mockApply = applyConnectorConfigs as ReturnType<typeof vi.fn>;
const mockDetectCollisions = detectConnectorEntityCollisions as ReturnType<
  typeof vi.fn
>;

const request: ApplyConnectorConfigsRequest = {
  projectRoot: '/proj',
  connectors: [
    {
      name: 'inventory',
      type: 'fabric-sqldatabase',
      config: { workspaceId: 'source-ws', itemId: 'source-item' },
      auth: { type: 'delegated' },
    },
  ],
  itemEndpoint: 'https://api.test/item-1',
  itemId: 'item-1',
  authorizationHeader: 'Bearer tok',
};

describe('createCliConnectorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerate.mockResolvedValue({ results: [], generated: ['inventory'] });
    mockDetectCollisions.mockReturnValue([]);
    mockApply.mockResolvedValue({
      results: [
        {
          name: 'inventory',
          connector: 'fabric-sqldatabase',
          status: 'success',
        },
      ],
      steps: {},
    });
  });

  it('generates before applying with the legacy up targeting inputs', async () => {
    await createCliConnectorService().applyConfigs(request);

    expect(mockGenerate).toHaveBeenCalledWith({
      projectRoot: '/proj',
      connectors: request.connectors,
      connectorNames: ['inventory'],
      verbose: false,
      mode: 'silent',
    });
    expect(mockApply).toHaveBeenCalledWith({
      itemEndpoint: 'https://api.test/item-1',
      rayfinItemId: 'item-1',
      authorizationHeader: 'Bearer tok',
      projectRoot: '/proj',
      connectors: request.connectors,
      mode: 'silent',
      verbose: expect.any(Function),
      context: 'inline',
    });
    expect(mockGenerate.mock.invocationCallOrder[0]).toBeLessThan(
      mockApply.mock.invocationCallOrder[0]
    );
  });

  it('returns host-neutral per-connector outcomes', async () => {
    const result = await createCliConnectorService().applyConfigs(request);

    expect(result).toEqual({
      results: [{ name: 'inventory', status: 'success' }],
    });
  });

  it('preserves typed skip reasons while mapping host outcomes', async () => {
    mockApply.mockResolvedValueOnce({
      results: [
        {
          name: 'inventory',
          connector: 'fabric-sqldatabase',
          status: 'skipped',
          skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
          reason: 'Generated connector configuration was not found.',
        },
      ],
      steps: {},
    });

    const result = await createCliConnectorService().applyConfigs(request);

    expect(result).toEqual({
      results: [
        {
          name: 'inventory',
          status: 'skipped',
          skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
          reason: 'Generated connector configuration was not found.',
        },
      ],
    });
  });

  it('does not apply when connector generation rejects', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('compile failed'));

    await expect(
      createCliConnectorService().applyConfigs(request)
    ).rejects.toThrow('compile failed');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('does not apply when generated connectors have colliding GraphQL types', async () => {
    mockDetectCollisions.mockReturnValueOnce([
      {
        entityName: 'Product',
        connectors: ['inventory', 'orders'],
      },
    ]);

    await expect(
      createCliConnectorService().applyConfigs(request)
    ).rejects.toThrow(
      'Duplicate GraphQL type names detected across connectors:'
    );
    expect(mockDetectCollisions).toHaveBeenCalledWith('/proj', ['inventory']);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('excludes a connector whose generation errored from apply and surfaces the error', async () => {
    mockGenerate.mockResolvedValueOnce({
      results: [
        {
          name: 'inventory',
          connector: 'fabric-sqldatabase',
          status: 'error',
          error: 'schema compile failed',
        },
      ],
      generated: [],
    });
    mockApply.mockResolvedValueOnce({ results: [], steps: {} });

    const result = await createCliConnectorService().applyConfigs(request);
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({ connectors: [] })
    );
    expect(result).toEqual({
      results: [
        {
          name: 'inventory',
          status: 'error',
          error: 'schema compile failed',
        },
      ],
    });
  });

  it('defensively excludes a GraphQL connector omitted from generated names', async () => {
    // Preserve compatibility with an older or alternate generator that returns
    // a skip instead of an error. It is NOT in `generated`, so it must be
    // excluded from apply rather than redeploying a stale dab-config.json.
    mockGenerate.mockResolvedValueOnce({
      results: [
        {
          name: 'inventory',
          connector: 'fabric-sqldatabase',
          status: 'skipped',
          reason: 'generated connector configuration was not found',
        },
      ],
      generated: [],
    });
    mockApply.mockResolvedValueOnce({ results: [], steps: {} });

    const result = await createCliConnectorService().applyConfigs(request);

    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({ connectors: [] })
    );
    expect(result).toEqual({
      results: [
        {
          name: 'inventory',
          status: 'skipped',
          skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
          reason: 'generated connector configuration was not found',
        },
      ],
    });
  });
});
