/** Invocation enrichment owned by the Node.js CLI hosts. */

import { getRootActivityId } from '@microsoft/rayfin-tools-common/_internal/external/fabric';
import {
  isTelemetryEnvironment,
  type InvocationContext,
  type TelemetryEnvironment,
} from '@microsoft/rayfin-tools-common/_internal/telemetry';

import { getCurrentContext } from './context-store.js';

/** Add the optional host-supplied telemetry environment to an invocation. */
export function addTelemetryEnvironment(
  context: InvocationContext,
  environmentVariables: Readonly<
    Record<string, string | undefined>
  > = process.env
): void {
  const environment = resolveTelemetryEnvironment(environmentVariables);
  if (environment) {
    context.addProperty('telemetry_environment', environment);
  }
}

/** Resolve a normalized, telemetry-safe execution environment label. */
export function resolveTelemetryEnvironment(
  environmentVariables: Readonly<Record<string, string | undefined>>
): TelemetryEnvironment | undefined {
  // Empty or whitespace-only overrides defer to host auto-detection.
  const override = environmentVariables['RAYFIN_TELEMETRY_ENV']
    ?.trim()
    .toLowerCase();
  if (override) {
    return isTelemetryEnvironment(override) ? override : 'other';
  }

  // Order is intentional: Codespaces precedes named CI providers, which
  // precede generic container and CI signals when multiple signals are set.
  if (isTrue(environmentVariables['CODESPACES'])) return 'codespaces';
  if (isTrue(environmentVariables['GITHUB_ACTIONS'])) return 'github-actions';
  if (isTrue(environmentVariables['TF_BUILD'])) return 'azure-pipelines';
  if (isTrue(environmentVariables['GITLAB_CI'])) return 'gitlab-ci';
  if (
    environmentVariables['JENKINS_URL'] ||
    environmentVariables['JENKINS_HOME']
  ) {
    return 'jenkins';
  }
  if (
    isTrue(environmentVariables['REMOTE_CONTAINERS']) ||
    isTrue(environmentVariables['DEVCONTAINER'])
  ) {
    return 'devcontainer';
  }
  if (isTrue(environmentVariables['CI'])) return 'other';
  return undefined;
}

function isTrue(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true' || value === '1';
}

/** Record the Fabric activity ID carried by a response, when present. */
export function recordFabricResponseActivity(response: Response): void {
  getCurrentContext()?.recordFabricActivityId(getRootActivityId(response));
}
