import { describe, expect, it, vi } from 'vitest';

import {
  CONNECTOR_CONFIG_SKIP_REASON,
  type ConnectorService,
} from '../../../../services/connectors/index.js';
import { applyConnectorConfigs } from '../apply-connector-configs.js';

const target = {
  itemId: 'item-1',
  itemEndpoint: 'https://api.test/item-1',
  baasEndpoint: 'https://baas.test/item-1',
  authorizationHeader: 'Bearer token',
};

const input = {
  projectRoot: '/project',
  connectors: [],
  target,
};

function fakeConnectorService(
  results: Awaited<ReturnType<ConnectorService['applyConfigs']>>['results']
): ConnectorService {
  return {
    applyConfigs: vi.fn().mockResolvedValue({ results }),
  };
}

describe('applyConnectorConfigs', () => {
  it('turns a per-connector apply error into a warning', async () => {
    const result = await applyConnectorConfigs(input, {
      connectors: fakeConnectorService([
        { name: 'inventory', status: 'error', error: 'apply rejected' },
      ]),
    });

    expect(result.warnings).toEqual([
      'Connector "inventory" apply failed: apply rejected',
      '1 connector(s) failed to apply: inventory',
      'Retry all:      rayfin up connector apply',
      'Retry one:      rayfin up connector apply --name inventory',
    ]);
  });

  it('warns when a GraphQL connector has no generated DAB config', async () => {
    const result = await applyConnectorConfigs(input, {
      connectors: fakeConnectorService([
        {
          name: 'inventory',
          status: 'skipped',
          skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
          reason: 'Generated connector configuration was not found.',
        },
      ]),
    });

    expect(result.warnings).toEqual([
      'Connector "inventory" was not applied: Generated connector configuration was not found.',
    ]);
  });

  it('does not warn when a non-GraphQL connector is intentionally skipped', async () => {
    const result = await applyConnectorConfigs(input, {
      connectors: fakeConnectorService([
        {
          name: 'analytics',
          status: 'skipped',
          skipReason: CONNECTOR_CONFIG_SKIP_REASON.NonGraphQlConnector,
          reason: 'not a GraphQL connector (type=fabric-semanticmodel)',
        },
      ]),
    });

    expect(result.warnings).toEqual([]);
  });
});
