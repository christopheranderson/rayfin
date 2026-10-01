/**
 * Fabric readiness internals.
 *
 * These modules are the shared readiness workflow's focused verbs. Hosts use
 * the workflow entry point and do not import these steps directly.
 */
export { selectCapacity } from './capacity-selection.js';
export {
  confirmCapacityAssignment,
  trialAssignmentConfirmationRequired,
} from './assignment-consent.js';
export {
  cancelledReadiness,
  errorMessage,
  isReadinessCancelled,
  problem,
  reportCompleted,
  reportNotice,
  ready,
  reportPhase,
} from './outcomes.js';
export { delay } from './polling.js';
export {
  eligibilityProblem,
  fabricProblem,
  isExistingTrialError,
  isTransientFabricError,
} from './problems.js';
export { selectTrialCapacity } from './trial-provisioning.js';
export { readinessHint, readinessHintForReason } from './remediation.js';
export {
  assignmentState,
  capacityHealth,
  verifyWorkspaceCapacity,
  workspaceName,
} from './workspace-target.js';
export type { AssignmentState, CapacityHealth } from './workspace-target.js';
export type {
  CapacitySelection,
  CapacityAssignmentMode,
  EnsureFabricTargetDeps,
  EnsureFabricTargetInput,
  EnsureFabricTargetResult,
  FabricCapacitySource,
  FabricCapacityAssignmentDeclined,
  FabricPollingOptions,
  FabricReadinessClient,
  FabricReadinessProblem,
  FabricReadinessNotice,
  FabricReadinessReason,
  FabricTargetReady,
  PremiumCapacitySelectionPolicy,
  TrialLookup,
  WorkspaceVerification,
} from './types.js';
