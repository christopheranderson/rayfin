/**
 * Connector product-service contract (Layer 3).
 *
 * Generates and applies GraphQL-backed connector configuration for a deployed
 * Rayfin item. The universal workflow depends only on this contract; project
 * compilation, filesystem access, and workload requests stay in the host.
 */
import type { RayfinConfig } from '../../config/index.js';

/** Inputs for applying a project's connector configurations. */
export interface ApplyConnectorConfigsRequest {
  projectRoot: string;
  connectors: NonNullable<RayfinConfig['connectors']>;
  itemEndpoint: string;
  itemId: string;
  authorizationHeader: string;
}

/** Stable reasons why a connector configuration was intentionally skipped. */
export const CONNECTOR_CONFIG_SKIP_REASON = {
  MissingGeneratedConfig: 'missing-generated-config',
  NonGraphQlConnector: 'non-graphql-connector',
} as const;

export type ConnectorConfigSkipReason =
  (typeof CONNECTOR_CONFIG_SKIP_REASON)[keyof typeof CONNECTOR_CONFIG_SKIP_REASON];

/**
 * Format the shared "some connectors failed to apply" retry guidance so the
 * wording stays identical between the legacy `up` path and the v2 workflow
 * step. Returns plain lines (no emoji/indent); the first line is a summary and
 * the rest are copy-pasteable retry commands, one per line. Each caller renders
 * them with its own mode-aware prefix. Returns an empty array when nothing
 * failed.
 */
export function formatFailedConnectorsRetryTip(
  failedNames: readonly string[]
): string[] {
  if (failedNames.length === 0) return [];
  const lines = [
    `${failedNames.length} connector(s) failed to apply: ${failedNames.join(', ')}`,
    'Retry all:      rayfin up connector apply',
    `Retry one:      rayfin up connector apply --name ${failedNames[0]}`,
  ];
  for (const name of failedNames.slice(1)) {
    // Align continuation commands under the first "rayfin" (16-char label).
    lines.push(`                rayfin up connector apply --name ${name}`);
  }
  return lines;
}

/** Outcome for one declared connector. */
export type ConnectorConfigApplyResult =
  | { name: string; status: 'success' }
  | {
      name: string;
      status: 'skipped';
      skipReason: ConnectorConfigSkipReason;
      reason: string;
    }
  | { name: string; status: 'error'; error: string };

/** Aggregate outcome for connector generation and apply. */
export interface ApplyConnectorConfigsResult {
  results: ConnectorConfigApplyResult[];
}

export interface ConnectorService {
  /** Generate and apply every supported connector configuration. */
  applyConfigs(
    request: ApplyConnectorConfigsRequest
  ): Promise<ApplyConnectorConfigsResult>;
}
