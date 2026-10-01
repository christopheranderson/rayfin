/** CLI implementation of the connector product-service contract. */
import type { Diagnostics } from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  CONNECTOR_CONFIG_SKIP_REASON,
  type ApplyConnectorConfigsRequest,
  type ConnectorService,
} from '@microsoft/rayfin-tools-common/_internal/services/connectors';

import { generateConnectorDabConfigs } from '../services/connector-generator.js';
import {
  applyConnectorConfigs,
  detectConnectorEntityCollisions,
  detectReservedConnectorEntityNames,
  formatConnectorEntityCollisionError,
  formatReservedConnectorEntityNameError,
  selectConnectorsToApply,
} from '../utils/connector-apply.js';

export interface CreateCliConnectorServiceOptions {
  diagnostics?: Diagnostics;
}

/** Construct the CLI-host connector service from the existing v1 utilities. */
export function createCliConnectorService(
  options: CreateCliConnectorServiceOptions = {}
): ConnectorService {
  const verbose = (...args: unknown[]): void => {
    options.diagnostics?.debug({
      area: 'connectors',
      message: args.map(String).join(' '),
    });
  };

  return {
    async applyConfigs(request: ApplyConnectorConfigsRequest) {
      const connectorNames = request.connectors.map((entry) => entry.name);
      const generateOutcome = await generateConnectorDabConfigs({
        projectRoot: request.projectRoot,
        connectors: request.connectors,
        connectorNames,
        verbose: false,
        mode: 'silent',
        diagnostics: options.diagnostics,
      });

      const connectorsToApply = selectConnectorsToApply(
        request.connectors,
        generateOutcome.generated
      );
      const applyNames = connectorsToApply.map((entry) => entry.name);
      const reserved = detectReservedConnectorEntityNames(
        request.projectRoot,
        applyNames
      );
      if (reserved.length > 0) {
        throw new Error(formatReservedConnectorEntityNameError(reserved));
      }
      const collisions = detectConnectorEntityCollisions(
        request.projectRoot,
        applyNames
      );
      if (collisions.length > 0) {
        throw new Error(formatConnectorEntityCollisionError(collisions));
      }

      const appliedNames = new Set(
        connectorsToApply.map((entry) => entry.name)
      );

      // Connectors excluded from apply (GraphQL, not freshly generated) would
      // otherwise vanish from the response. Surface their generation outcome so
      // callers still see the error or skip.
      const excludedResults = generateOutcome.results
        .filter((result) => !appliedNames.has(result.name))
        .map((result) =>
          result.status === 'error'
            ? {
                name: result.name,
                status: 'error' as const,
                error:
                  result.error ??
                  result.reason ??
                  'Connector configuration generation failed.',
              }
            : {
                name: result.name,
                status: 'skipped' as const,
                skipReason: CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig,
                reason:
                  result.reason ??
                  'Generated connector configuration was not found.',
              }
        );

      const outcome = await applyConnectorConfigs({
        itemEndpoint: request.itemEndpoint,
        rayfinItemId: request.itemId,
        authorizationHeader: request.authorizationHeader,
        projectRoot: request.projectRoot,
        connectors: connectorsToApply,
        mode: 'silent',
        verbose,
        context: 'inline',
        diagnostics: options.diagnostics,
      });

      return {
        results: [
          ...excludedResults,
          ...outcome.results.map((result) => {
            switch (result.status) {
              case 'success':
                return { name: result.name, status: result.status };
              case 'skipped':
                return {
                  name: result.name,
                  status: result.status,
                  skipReason: result.skipReason,
                  reason: result.reason,
                };
              case 'error':
                return {
                  name: result.name,
                  status: result.status,
                  error: result.error,
                };
            }
          }),
        ],
      };
    },
  };
}
