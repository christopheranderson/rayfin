/**
 * The `dev` backend-provider seam.
 *
 * Hosts import {@link DevBackendProvider} to implement a concrete backend
 * strategy (the CLI's `FabricDevProvider` / `DockerDevProvider`); the workflow
 * imports the same interface to declare `deps.backend`.
 */
export type {
  ApplyDataConfigInput,
  ApplyStorageConfigInput,
  DevBackendProvider,
  DevProviderRequest,
  DevTarget,
  EnsureBackendReadyOutcome,
  LocalDevWiring,
  PrepareLocalFrontendOptions,
  TeardownOptions,
} from './types.js';
