import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

const PACKAGE_JSON = 'package.json';
const WORKSPACE_GLOB = /^(.*)\/\*$/u;

export interface AppPackageManifest {
  readonly directory: string;
  readonly relativeDirectory: string;
  readonly manifestPath: string;
  readonly packageJson: Record<string, unknown>;
}

export interface AppManifestSet {
  readonly root: AppPackageManifest;
  readonly members: readonly AppPackageManifest[];
  readonly workspace: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileSystemError(
  error: unknown,
  code: string
): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? `: ${error.message}` : '';
}

async function nearestExistingRealPath(
  candidate: string,
  label: string
): Promise<{ readonly ancestor: string; readonly suffix: readonly string[] }> {
  const suffix: string[] = [];
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
    } catch (error: unknown) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw new Error(
          `${label} cannot be inspected safely at ${current}${errorDetail(error)}`
        );
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(
          `${label} has no existing ancestor that can be resolved safely.`
        );
      }
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }

    try {
      return { ancestor: await realpath(current), suffix };
    } catch (error: unknown) {
      throw new Error(
        `${label} cannot be resolved safely at ${current}${errorDetail(error)}`
      );
    }
  }
}

async function realContainedPath(
  appDirectory: string,
  candidate: string,
  label: string
): Promise<string> {
  const lexicalRoot = path.resolve(appDirectory);
  let realRoot: string;
  try {
    realRoot = await realpath(lexicalRoot);
  } catch (error: unknown) {
    throw new Error(
      `App root cannot be resolved safely at ${lexicalRoot}${errorDetail(error)}`
    );
  }

  const { ancestor, suffix } = await nearestExistingRealPath(candidate, label);
  if (!isContained(realRoot, ancestor)) {
    throw new Error(
      `${label} resolves outside the app root through a symbolic link or junction. Keep it inside ${realRoot}.`
    );
  }

  const resolved = path.resolve(ancestor, ...suffix);
  if (!isContained(realRoot, resolved)) {
    throw new Error(`${label} must stay inside the app root.`);
  }
  return resolved;
}

/**
 * Resolve a relative path without allowing lexical or filesystem-link escapes.
 *
 * Returning the canonical path avoids reusing checked symlink components.
 * Mutating callers still revalidate immediately before writes because portable
 * Node.js APIs do not offer directory-handle-relative rename operations.
 */
async function containedPath(
  appDirectory: string,
  relativePath: string,
  label: string
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative to the app root.`);
  }
  const lexicalRoot = path.resolve(appDirectory);
  const lexicalTarget = path.resolve(lexicalRoot, relativePath);
  if (!isContained(lexicalRoot, lexicalTarget)) {
    throw new Error(`${label} must stay inside the app root.`);
  }
  return await realContainedPath(appDirectory, lexicalTarget, label);
}

export async function resolveAppPath(
  appDirectory: string,
  candidate: string,
  label: string
): Promise<string> {
  return path.isAbsolute(candidate)
    ? await realContainedPath(appDirectory, path.resolve(candidate), label)
    : await containedPath(appDirectory, candidate, label);
}

async function readManifest(
  appDirectory: string,
  relativeDirectory: string,
  label: string
): Promise<AppPackageManifest> {
  const directory = await containedPath(appDirectory, relativeDirectory, label);
  const manifestPath = await containedPath(
    appDirectory,
    path.join(relativeDirectory, PACKAGE_JSON),
    `${label} package.json`
  );
  let contents: string;
  try {
    contents = await readFile(manifestPath, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `${label} is missing or unreadable at ${manifestPath}${reason}. Restore a readable package.json at that path and retry validation.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `${label} contains malformed JSON at ${manifestPath}${reason}. Correct the package.json and retry validation.`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${label} must contain a JSON object at ${manifestPath}. Correct the package.json and retry validation.`
    );
  }
  return {
    directory,
    relativeDirectory,
    manifestPath,
    packageJson: parsed,
  };
}

function workspacePatterns(packageJson: Record<string, unknown>): {
  readonly declared: boolean;
  readonly patterns: readonly string[];
} {
  if (packageJson.workspaces === undefined) {
    return { declared: false, patterns: [] };
  }
  const raw = Array.isArray(packageJson.workspaces)
    ? packageJson.workspaces
    : isRecord(packageJson.workspaces) &&
        Array.isArray(packageJson.workspaces.packages)
      ? packageJson.workspaces.packages
      : undefined;
  if (
    raw === undefined ||
    raw.length === 0 ||
    raw.some(
      (entry: unknown) => typeof entry !== 'string' || entry.length === 0
    )
  ) {
    throw new Error(
      'Root package.json workspaces must contain an array of package paths or an object with a non-empty packages array.'
    );
  }
  return { declared: true, patterns: raw as readonly string[] };
}

async function expandWorkspacePattern(
  appDirectory: string,
  pattern: string
): Promise<readonly string[]> {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('!') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Unsupported workspace declaration "${pattern}".`);
  }
  if (!normalized.includes('*')) {
    await containedPath(
      appDirectory,
      normalized,
      `Workspace member "${pattern}"`
    );
    return [normalized];
  }
  const match = WORKSPACE_GLOB.exec(normalized);
  if (match?.[1] === undefined || match[1].includes('*')) {
    throw new Error(
      `Unsupported workspace pattern "${pattern}". Universal App supports explicit members and one-level "directory/*" patterns.`
    );
  }
  const parentRelative = match[1];
  const parent = await containedPath(
    appDirectory,
    parentRelative,
    `Workspace pattern "${pattern}"`
  );
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error: unknown) {
    const reason = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `Workspace pattern "${pattern}" cannot be read at ${parent}${reason}`
    );
  }
  const members = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parentRelative}/${entry.name}`)
    .sort();
  if (members.length === 0) {
    throw new Error(
      `Workspace pattern "${pattern}" matches no package directories.`
    );
  }
  return members;
}

/**
 * Read the root package manifest and every declared npm workspace member.
 *
 * A root without `workspaces` is a supported legacy flat app. Once workspaces
 * are declared, every matched member is authoritative and must be readable.
 */
export async function readAppPackageManifests(
  appDirectory: string
): Promise<AppManifestSet> {
  const root = await readManifest(appDirectory, '.', 'Root package.json');
  const { declared, patterns } = workspacePatterns(root.packageJson);
  if (!declared) return { root, members: [], workspace: false };

  const relativeMembers = new Set<string>();
  for (const pattern of patterns) {
    for (const member of await expandWorkspacePattern(appDirectory, pattern)) {
      relativeMembers.add(member);
    }
  }
  const members: AppPackageManifest[] = [];
  for (const relativeDirectory of [...relativeMembers].sort()) {
    members.push(
      await readManifest(
        appDirectory,
        relativeDirectory,
        `Declared workspace member "${relativeDirectory}"`
      )
    );
  }
  return { root, members, workspace: true };
}

async function readServices(
  appDirectory: string
): Promise<Record<string, unknown>> {
  const configPath = await containedPath(
    appDirectory,
    path.join('rayfin', 'rayfin.yml'),
    'Rayfin configuration'
  );
  const parsed = parseYaml(await readFile(configPath, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} must contain a YAML object.`);
  }
  return isRecord(parsed.services) ? parsed.services : {};
}

export async function resolveServiceDirectory(
  appDirectory: string,
  serviceName: string,
  fallback: string
): Promise<string> {
  const service = (await readServices(appDirectory))[serviceName];
  if (service !== undefined && !isRecord(service)) {
    throw new Error(`services.${serviceName} must be a YAML object.`);
  }
  const configured = service?.path;
  if (configured !== undefined && typeof configured !== 'string') {
    throw new Error(`services.${serviceName}.path must be a relative path.`);
  }
  return await containedPath(
    appDirectory,
    configured ?? fallback,
    `services.${serviceName}.path`
  );
}

export async function resolveStaticSourceDirectory(
  appDirectory: string
): Promise<string> {
  const services = await readServices(appDirectory);
  const service = services.staticHosting;
  if (service !== undefined && !isRecord(service)) {
    throw new Error('services.staticHosting must be a YAML object.');
  }
  const configuredPath = service?.path;
  const root = service?.root;
  if (configuredPath !== undefined && typeof configuredPath !== 'string') {
    throw new Error('services.staticHosting.path must be a relative path.');
  }
  if (root !== undefined && typeof root !== 'string') {
    throw new Error('services.staticHosting.root must be a relative path.');
  }
  const serviceDirectory = await containedPath(
    appDirectory,
    configuredPath ?? '.',
    'services.staticHosting.path'
  );
  return await containedPath(
    serviceDirectory,
    root ?? '.',
    'services.staticHosting.root'
  );
}

export async function resolveStaticSourcePath(
  appDirectory: string,
  relativePath: string,
  label: string
): Promise<string> {
  const sourceDirectory = await resolveStaticSourceDirectory(appDirectory);
  return await containedPath(sourceDirectory, relativePath, label);
}

export async function resolveStaticArtifactDirectory(
  appDirectory: string
): Promise<string> {
  const services = await readServices(appDirectory);
  const service = services.staticHosting;
  if (service !== undefined && !isRecord(service)) {
    throw new Error('services.staticHosting must be a YAML object.');
  }
  const folder = service?.folder;
  if (folder !== undefined && typeof folder !== 'string') {
    throw new Error('services.staticHosting.folder must be a relative path.');
  }
  const sourceDirectory = await resolveStaticSourceDirectory(appDirectory);
  return await containedPath(
    sourceDirectory,
    folder ?? 'dist',
    'services.staticHosting.folder'
  );
}
