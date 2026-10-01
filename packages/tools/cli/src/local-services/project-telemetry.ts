/** CLI host implementation of project telemetry persistence and collection. */
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { resolveInstalledPackageVersions } from '@microsoft/rayfin-docs/_internal/site-discovery';
import type {
  DeploymentTelemetryFacts,
  ProjectMetadata,
  ProjectTelemetryService,
} from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import {
  PROJECT_METADATA_COMMENT,
  PROJECT_METADATA_PATH,
} from '@microsoft/rayfin-tools-common/_internal/services/project-telemetry';
import {
  isApprovedMicrosoftPackageName,
  isTelemetryPackageVersion,
  isTelemetryPropertyValue,
  type MicrosoftPackageVersion,
} from '@microsoft/rayfin-tools-common/_internal/telemetry';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Create the Node-backed project telemetry service for the CLI host. */
export function createCliProjectTelemetryService(): ProjectTelemetryService {
  return {
    async persistProjectOrigin(
      projectRoot: string,
      projectOriginId: string
    ): Promise<void> {
      if (!isTelemetryPropertyValue('project_origin_id', projectOriginId)) {
        return;
      }
      const root = await realpath(resolve(projectRoot));
      // The hardcoded relative path is contained by construction. The post-mkdir
      // realpath check rejects symlink substitution; the realpath-to-rename window
      // is accepted because the threat model is the local user's project directory.
      const metadataDirectory = join(root, dirname(PROJECT_METADATA_PATH));
      await mkdir(metadataDirectory, { recursive: true });
      const realMetadataDirectory = await realpath(metadataDirectory);
      if (!isContained(root, realMetadataDirectory)) return;
      const path = join(realMetadataDirectory, basename(PROJECT_METADATA_PATH));
      const metadata: ProjectMetadata = {
        _comment: PROJECT_METADATA_COMMENT,
        version: 1,
        projectOriginId,
      };
      await writeJsonAtomic(path, metadata);
    },

    async collectDeploymentTelemetry(
      projectRoot: string,
      packageRoots: readonly string[]
    ): Promise<DeploymentTelemetryFacts> {
      const [projectOriginId, packageFacts] = await Promise.all([
        readProjectOrigin(projectRoot),
        collectMicrosoftPackages(projectRoot, packageRoots),
      ]);
      return {
        projectOriginId,
        microsoftPackages: packageFacts?.packages,
        unresolvedPackageCount: packageFacts?.unresolvedPackageCount,
      };
    },
  };
}

async function readProjectOrigin(
  projectRoot: string
): Promise<string | undefined> {
  try {
    const root = await realpath(resolve(projectRoot));
    const metadataPath = await realpath(join(root, PROJECT_METADATA_PATH));
    if (!isContained(root, metadataPath)) return undefined;
    const parsed = JSON.parse(
      await readFile(metadataPath, 'utf8')
    ) as Partial<ProjectMetadata>;
    return parsed.version === 1 &&
      typeof parsed.projectOriginId === 'string' &&
      isTelemetryPropertyValue('project_origin_id', parsed.projectOriginId)
      ? parsed.projectOriginId
      : undefined;
  } catch {
    return undefined;
  }
}

async function collectMicrosoftPackages(
  projectRoot: string,
  packageRoots: readonly string[]
): Promise<
  | {
      packages: MicrosoftPackageVersion[];
      unresolvedPackageCount: number;
    }
  | undefined
> {
  try {
    const root = await realpath(resolve(projectRoot));
    const packages: MicrosoftPackageVersion[] = [];
    const unresolvedPackageNames = new Set<string>();
    const visitedRoots = new Set<string>();
    let collectionFailed = false;
    for (const configuredRoot of [...new Set(['.', ...packageRoots])]) {
      const rootResolution = await resolveContainedRoot(root, configuredRoot);
      if (rootResolution.status === 'invalid') {
        collectionFailed = true;
        continue;
      }
      if (rootResolution.status === 'missing') continue;
      const packageRoot = rootResolution.path;
      if (visitedRoots.has(packageRoot)) continue;
      visitedRoots.add(packageRoot);
      const dependencyResult = await readMicrosoftDependencies(packageRoot);
      if (dependencyResult.status === 'invalid') {
        collectionFailed = true;
        continue;
      }
      if (dependencyResult.status === 'missing') continue;
      const candidates = dependencyResult.names;
      if (candidates.length === 0) continue;
      // Direct-only: the candidates are this manifest's own declared
      // dependencies, so one that does not resolve from here is a broken or
      // absent install worth counting as unresolved rather than hunting for
      // elsewhere in the tree.
      const resolution = resolveInstalledPackageVersions(
        candidates,
        packageRoot,
        { isVersionAllowed: isTelemetryPackageVersion }
      );
      packages.push(...resolution.packages);
      for (const packageName of resolution.unresolvedPackageNames) {
        unresolvedPackageNames.add(packageName);
      }
    }
    if (collectionFailed) return undefined;
    return {
      packages,
      unresolvedPackageCount: unresolvedPackageNames.size,
    };
  } catch {
    return undefined;
  }
}

type RootResolution =
  | { status: 'ok'; path: string }
  | { status: 'missing' }
  | { status: 'invalid' };

async function resolveContainedRoot(
  projectRoot: string,
  configuredRoot: string
): Promise<RootResolution> {
  if (isAbsolute(configuredRoot)) return { status: 'invalid' };
  const candidate = resolve(projectRoot, configuredRoot);
  if (!isContained(projectRoot, candidate)) return { status: 'invalid' };
  try {
    const realCandidate = await realpath(candidate);
    return isContained(projectRoot, realCandidate)
      ? { status: 'ok', path: realCandidate }
      : { status: 'invalid' };
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }
}

type DependencyReadResult =
  | { status: 'ok'; names: string[] }
  | { status: 'missing' }
  | { status: 'invalid' };

async function readMicrosoftDependencies(
  packageRoot: string
): Promise<DependencyReadResult> {
  let content: string;
  try {
    content = await readFile(join(packageRoot, 'package.json'), 'utf8');
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' };
  }

  try {
    const manifest = JSON.parse(content) as unknown;
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      return { status: 'invalid' };
    }
    const manifestRecord = manifest as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifestRecord[field];
      if (dependencies === undefined) continue;
      if (
        typeof dependencies !== 'object' ||
        dependencies === null ||
        Array.isArray(dependencies)
      ) {
        return { status: 'invalid' };
      }
      for (const name of Object.keys(dependencies)) {
        if (isApprovedMicrosoftPackageName(name)) names.add(name);
      }
    }
    return { status: 'ok', names: [...names] };
  } catch {
    return { status: 'invalid' };
  }
}

function isContained(projectRoot: string, candidate: string): boolean {
  const fromProject = relative(projectRoot, candidate);
  return (
    fromProject === '' ||
    (fromProject !== '..' &&
      !fromProject.startsWith(`..${sep}`) &&
      !isAbsolute(fromProject))
  );
}

// Promise-based analogue of utils/atomic-write.ts. Keeping the temporary file
// beside the target ensures rename() stays on the same filesystem.
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8'
    );
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
