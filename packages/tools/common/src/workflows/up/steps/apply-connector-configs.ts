/** `up` workflow step: generate and apply connector configurations. */
import type { RayfinConfig } from '../../../config/index.js';
import type { WorkloadTarget } from '../../../external/fabric/index.js';
import {
  CONNECTOR_CONFIG_SKIP_REASON,
  formatFailedConnectorsRetryTip,
  type ConnectorConfigApplyResult,
  type ConnectorService,
} from '../../../services/connectors/index.js';
import type { Step } from '../../types.js';

export interface ApplyConnectorConfigsInput {
  projectRoot: string;
  connectors: NonNullable<RayfinConfig['connectors']>;
  target: WorkloadTarget;
}

export interface ApplyConnectorConfigsResult {
  warnings: string[];
  results: ConnectorConfigApplyResult[];
}

export interface ApplyConnectorConfigsDeps {
  connectors: ConnectorService;
}

/**
 * Apply GraphQL-backed connector configs without making connector failures
 * fatal to the rest of the deployment, matching the legacy `up` behavior.
 */
export const applyConnectorConfigs: Step<
  ApplyConnectorConfigsInput,
  ApplyConnectorConfigsResult,
  ApplyConnectorConfigsDeps
> = async (input, { connectors }) => {
  try {
    const outcome = await connectors.applyConfigs({
      projectRoot: input.projectRoot,
      connectors: input.connectors,
      itemEndpoint: input.target.itemEndpoint,
      itemId: input.target.itemId,
      authorizationHeader: input.target.authorizationHeader,
    });

    const warnings: string[] = [];
    const failedNames: string[] = [];
    for (const result of outcome.results) {
      if (result.status === 'error') {
        failedNames.push(result.name);
        warnings.push(
          `Connector "${result.name}" apply failed: ${result.error ?? 'Unknown error'}`
        );
      } else if (
        result.status === 'skipped' &&
        result.skipReason ===
          CONNECTOR_CONFIG_SKIP_REASON.MissingGeneratedConfig
      ) {
        warnings.push(
          `Connector "${result.name}" was not applied: ${result.reason}`
        );
      }
    }

    // Surface a targeted re-run tip so a Builder can retry every failed
    // connector at once or one at a time without re-running the whole `up`.
    if (failedNames.length > 0) {
      warnings.push(...formatFailedConnectorsRetryTip(failedNames));
    }

    return { warnings, results: outcome.results };
  } catch (error) {
    return {
      warnings: [
        `Connector apply step failed: ${error instanceof Error ? error.message : String(error)}`,
        "Run 'rayfin up connector apply' after the workload is ready, or target a single connector with 'rayfin up connector apply --name <connector_name>'.",
      ],
      results: [],
    };
  }
};
