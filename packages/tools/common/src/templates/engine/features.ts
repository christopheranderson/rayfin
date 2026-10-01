import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const FEATURE_DIRECTORY = '.template-features';

function entryStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'Template feature directories must be real directories, not links.'
    );
  }
}

function assertDestination(root: string, path: string): void {
  const parts = relative(root, path).split(sep);
  if (
    parts.some(
      (part) =>
        part === '..' ||
        part === '.git' ||
        part === 'node_modules' ||
        part === FEATURE_DIRECTORY
    )
  ) {
    throw new Error(
      'Template features cannot write outside the app or into tool-state directories.'
    );
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = entryStat(current);
    if (!stat) continue;
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory())
    ) {
      throw new Error(
        'Template features cannot write through linked or non-directory paths.'
      );
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(
        'A template feature cannot replace a directory with a file.'
      );
    }
  }
}

/**
 * Applies declared template-owned file overlays before dependency installation.
 * The authoring payload and its declaration are consumed, not shipped in the app.
 * @internal Node-only template materialization shared by tool hosts.
 */
export function applyTemplateFeatures(
  targetPath: string,
  enabledFeatures: ReadonlySet<string>
): void {
  const root = resolve(targetPath);
  const manifestPath = join(root, 'package.json');
  const manifestStat = entryStat(manifestPath);
  if (!manifestStat) return;
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(
      'Template feature metadata must be a regular package.json file.'
    );
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.template) ||
    !Object.hasOwn(manifest.template, 'features')
  ) {
    return;
  }
  const features = manifest.template.features;
  if (
    !Array.isArray(features) ||
    !features.every(
      (feature): feature is string =>
        typeof feature === 'string' && /^[a-z][a-z0-9-]*$/.test(feature)
    ) ||
    new Set(features).size !== features.length
  ) {
    throw new Error(
      'template.features must be a list of unique lowercase feature names. Fix the template declaration before scaffolding again.'
    );
  }

  const sourceRoot = join(root, FEATURE_DIRECTORY);
  assertDirectory(root);
  const sourcePresent = entryStat(sourceRoot) !== undefined;
  if (sourcePresent || features.length) assertDirectory(sourceRoot);
  const copies: Array<{ source: string; destination: string }> = [];

  function collect(directory: string, destination: string, depth = 0): void {
    if (depth > 32)
      throw new Error('Template feature directory nesting exceeds 32 levels.');
    assertDirectory(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const target = join(destination, entry.name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        throw new Error(
          'Template feature files must not contain symbolic links.'
        );
      }
      if (stat.isDirectory()) {
        collect(source, target, depth + 1);
      } else if (stat.isFile()) {
        assertDestination(root, target);
        copies.push({ source, destination: target });
      } else {
        throw new Error(
          'Template features may contain only regular files and directories.'
        );
      }
    }
  }

  for (const feature of features) {
    const source = join(sourceRoot, feature);
    assertDirectory(source);
    if (enabledFeatures.has(feature)) collect(source, root);
  }

  for (const { source, destination } of copies) {
    mkdirSync(dirname(destination), { recursive: true });
    assertDestination(root, destination);
    copyFileSync(source, destination);
  }

  const result: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(result) || !isRecord(result.template)) {
    throw new Error(
      'A template feature must preserve the root package.json template metadata.'
    );
  }
  delete result.template.features;
  writeFileSync(manifestPath, JSON.stringify(result, null, 2) + '\n');
  if (sourcePresent) rmSync(sourceRoot, { recursive: true });
}
