/**
 * Deployment states for a FuncSet function deployment.
 */
export enum DeployState {
  NotDeployed = 'NotDeployed',
  InProgress = 'InProgress',
  Complete = 'Complete',
  Fail = 'Fail',
}

/**
 * Deployment information returned by the deployment status endpoint.
 */
export interface DeployInfo {
  /** Current deployment state. */
  status: DeployState;
  /** Human-readable error message when {@link status} is {@link DeployState.Fail}. */
  error?: string;
  /** Machine-readable error code when {@link status} is {@link DeployState.Fail}. */
  errorCode?: string;
  /** Whether the failure is caused by user input (e.g. bad code) vs a system error. */
  isUserError?: boolean;
  /** ISO 8601 timestamp when the deployment started. */
  startTime?: string;
  /** ISO 8601 timestamp when the deployment finished. */
  endTime?: string;
}

/**
 * Response body returned by the BaaS deploy endpoint on 202 Accepted.
 */
export interface DeployAcceptedResponse {
  udfArtifactId: string;
}

/**
 * Minimal shape of the FuncSet external metadata response,
 * containing only the `deploy` field used by the polling helper.
 */
export interface FunctionSetExternalMetadata {
  deploy: DeployInfo;
}
