/**
 * State-change equivalence helpers for cross-architecture parity testing.
 *
 * Used to compare on-disk state between the legacy code path
 * (`tools-arch-v2` off) and the new workflow-based path (`tools-arch-v2`
 * on) after running the same command. The contract is **state changes**,
 * not output bytes — printed output is allowed (and expected) to differ
 * as the new architecture cleans up known-buggy formatting.
 *
 * See "State changes are the contract; output is not" in
 * docs/rfc/rayfin-tools-architecture-migration.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

/**
 * Fields in `rayfin/.deployments.json` that legitimately vary between
 * runs even when the underlying deployment is the same (server-issued
 * timestamps). Excluded from `expectDeploymentRegistryEquivalent` so
 * parity tests don't flake on retry-induced timestamp drift.
 */
const VOLATILE_DEPLOYMENT_FIELDS = new Set<string>(['deployedAt']);

/**
 * Read and parse `rayfin/rayfin.yml` from a project directory.
 * Throws if the file is missing or unparseable.
 */
export function readRayfinYmlConfig(projectDir: string): unknown {
  const ymlPath = join(projectDir, 'rayfin', 'rayfin.yml');
  if (!existsSync(ymlPath)) {
    throw new Error(`rayfin.yml not found at ${ymlPath}`);
  }
  return parseYaml(readFileSync(ymlPath, 'utf8'));
}

/**
 * Read and parse `rayfin/.deployments.json` from a project directory.
 * Returns `null` if the file does not exist (legitimate state when
 * `rayfin up` hasn't been run yet).
 */
export function readDeploymentsRegistry(projectDir: string): unknown {
  const registryPath = join(projectDir, 'rayfin', '.deployments.json');
  if (!existsSync(registryPath)) {
    return null;
  }
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

/**
 * Strip volatile fields from each deployment entry so a deep-equal
 * comparison reflects state semantics, not server-issued timestamp
 * drift. Pure; does not mutate the input.
 */
export function stripVolatileDeploymentFields(registry: unknown): unknown {
  if (!registry || typeof registry !== 'object') return registry;
  const r = registry as { deployments?: Record<string, unknown> };
  if (!r.deployments || typeof r.deployments !== 'object') return registry;

  const sanitized: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(r.deployments)) {
    if (entry && typeof entry === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (!VOLATILE_DEPLOYMENT_FIELDS.has(key)) {
          copy[key] = value;
        }
      }
      sanitized[name] = copy;
    } else {
      sanitized[name] = entry;
    }
  }

  return { ...r, deployments: sanitized };
}

/**
 * Parsed `rayfin.yml` content suitable for deep-equal comparison.
 * Compares semantic config (parsed YAML), not file bytes — whitespace,
 * key ordering, and comment style may legitimately differ between paths.
 */
export interface RayfinYmlEquivalent {
  yml: unknown;
}

/**
 * Sanitized deployment registry suitable for deep-equal comparison.
 * Volatile fields (timestamps) have been stripped.
 */
export interface DeploymentRegistryEquivalent {
  registry: unknown;
}

/**
 * Capture the equivalent-comparable state of a project directory.
 *
 * Used by tests that scaffold or deploy with two flag states and want
 * to assert "the resulting on-disk state is semantically the same."
 */
export function captureProjectState(projectDir: string): {
  rayfinYml: RayfinYmlEquivalent;
  deployments: DeploymentRegistryEquivalent;
} {
  return {
    rayfinYml: { yml: readRayfinYmlConfig(projectDir) },
    deployments: {
      registry: stripVolatileDeploymentFields(
        readDeploymentsRegistry(projectDir)
      ),
    },
  };
}
