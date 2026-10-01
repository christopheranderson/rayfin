import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

// A developer may install the committed template directly; the harness itself
// installs only in target/, so node_modules is the sole practical exclusion.
const ignoredDirectoryNames = new Set(['node_modules']);

function collectFiles(root, directory, snapshot) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/');

    if (entry.isDirectory()) {
      snapshot.set(relativePath, 'directory');
      collectFiles(root, absolutePath, snapshot);
      continue;
    }

    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      snapshot.set(relativePath, `symlink:${readlinkSync(absolutePath)}`);
      continue;
    }

    const digest = createHash('sha256')
      .update(readFileSync(absolutePath))
      .digest('hex');
    snapshot.set(relativePath, `file:${digest}`);
  }
}

export function snapshotTemplate(templateDir) {
  const snapshot = new Map();
  collectFiles(templateDir, templateDir, snapshot);
  return snapshot;
}

export function assertTemplateUnchanged(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changedPaths = [...paths]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();

  if (changedPaths.length > 0) {
    throw new Error(
      `Harness preparation modified template source:\n${changedPaths
        .map((path) => `- ${path}`)
        .join('\n')}`
    );
  }
}
