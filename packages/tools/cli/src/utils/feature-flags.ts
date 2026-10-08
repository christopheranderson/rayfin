import {
  createFeatureFlags,
  parseFeatureFlags,
} from '@microsoft/rayfin-tools-common/_internal';
import type {
  FeatureFlagContext,
  FeatureFlagsRegistry,
} from '@microsoft/rayfin-tools-common/_internal';

import { loadEnvironmentVariables, loadRayfinConfig } from './config-utils.js';
import { findRayfinProjectRoot } from './project-utils.js';

export interface FeatureFlagContextLoadOptions {
  command?: 'up' | 'dev';
  envFile?: string;
  processEnv?: typeof process.env;
  silent?: boolean;
}

const mapProcessEnv = (
  processEnv: typeof process.env = process.env
): Map<string, string> => {
  const env = new Map<string, string>();

  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      env.set(key, value);
    }
  }

  return env;
};

export {
  createFeatureFlags,
  FEATURE_FLAGS_ENV_VAR,
  normalizeFeatureFlagName,
  parseFeatureFlags,
} from '@microsoft/rayfin-tools-common/_internal';
export type {
  FeatureFlagResolver,
  FeatureFlagValue,
} from '@microsoft/rayfin-tools-common/_internal';

export const createFeatureFlagContext = (
  startPath: string = process.cwd(),
  options: FeatureFlagContextLoadOptions = {}
): FeatureFlagContext => {
  const { command, envFile, processEnv = process.env, silent = true } = options;

  let projectRoot: string | undefined;

  try {
    projectRoot = findRayfinProjectRoot(startPath, {
      verbose: false,
      silent,
    });
  } catch {
    projectRoot = undefined;
  }

  if (!projectRoot) {
    return {
      env: mapProcessEnv(processEnv),
      rayfinConfig: null,
    };
  }

  return {
    env: loadEnvironmentVariables({
      projectRoot,
      envFilePath: envFile,
      command,
      processEnv,
    }),
    rayfinConfig: loadRayfinConfig(projectRoot, {
      silent,
      envFile,
      command,
    }),
  };
};

export const createCliFeatureFlags = (
  startPath: string = process.cwd(),
  options: FeatureFlagContextLoadOptions = {}
): FeatureFlagsRegistry => {
  const featureFlags = createFeatureFlags(
    createFeatureFlagContext(startPath, options)
  );

  featureFlags.register('storage', {
    // Storage is a preview feature (see GA issue #1523). It activates when the
    // project declares it in rayfin.yml (`services.storage.enabled`) or opts in
    // via RAYFIN_FEATURE_FLAGS=storage.
    on: (env, rayfinConfig) => {
      if (rayfinConfig?.services?.storage?.enabled === true) {
        return true;
      }

      return parseFeatureFlags(env).has('storage');
    },
  });

  featureFlags.register('postgresql', {
    on: (env, rayfinConfig) => {
      if (rayfinConfig?.services?.data?.dialect === 'postgresql') {
        return true;
      }

      return parseFeatureFlags(env).has('postgresql');
    },
  });

  featureFlags.register('docker-local-dev', {
    on: (env) => {
      return parseFeatureFlags(env).has('docker-local-dev');
    },
  });

  // Selects the workflow-based code path (target architecture) over the
  // legacy orchestration for migrated commands. Default off. Flipped on
  // per command only after CI E2E has been green in both states.
  // See docs/rfc/rayfin-tools-architecture-migration.md.
  featureFlags.register('tools-arch-v2', {
    on: (env) => {
      return parseFeatureFlags(env).has('tools-arch-v2');
    },
  });

  // Internal, undocumented kill-switch that falls `rayfin up` back to the
  // legacy (pre-v2) orchestration for emergency diagnosis without a rebuild.
  // The v2 workflow path is the default for `up`; this flag exists only to keep
  // the legacy code reachable during its bake-in window. Removed with the
  // legacy `up` code in migration Phase 2.4.
  featureFlags.register('up-legacy', {
    on: (env) => {
      return parseFeatureFlags(env).has('up-legacy');
    },
  });

  // Gates the `rayfin up` static-hosting posture onboarding and the minimum
  // auth SDK check. Always on: every Builder should get posture onboarding.
  featureFlags.register('cli-up-anonstatic', {
    on: () => true,
  });

  // Placeholder gate for small, low-risk CLI adjustments that share a common opt-out.
  featureFlags.register('cli-minor-fixes', {
    on: (env) => {
      return parseFeatureFlags(env).has('cli-minor-fixes');
    },
  });

  return featureFlags;
};
