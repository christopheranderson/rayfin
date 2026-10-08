import { copyFile, lstat, mkdir, readdir, realpath } from 'fs/promises';
import { join, relative, resolve, sep, dirname } from 'path';

/** Default patterns to ignore when processing template files. */
const DEFAULT_IGNORE = [
  'rayfin-template.yml',
  '.git',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
];

export interface ProcessFilesOptions {
  sourceDir: string;
  targetDir: string;
  context: Record<string, unknown>;
  ignorePatterns?: string[];
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface ProcessFilesResult {
  createdFiles: string[];
  skippedFiles: string[];
}

/**
 * Replace __paramName__ placeholders in a filename with context values.
 */
export function renderFilename(
  filename: string,
  context: Record<string, unknown>
): string {
  return filename.replace(
    /__([a-zA-Z_][a-zA-Z0-9_]*)__/g,
    (_match, key: string) => {
      const val = context[key];
      if (val === undefined) return _match;
      // Sanitize path separators to prevent unintended subdirectory creation
      return String(val).replace(/[/\\]/g, '_');
    }
  );
}

/** Shared state threaded through the recursive walk. */
interface WalkState {
  rootSource: string;
  rootTarget: string;
  realRoot: string;
  context: Record<string, unknown>;
  ignorePatterns: string[];
  createdFiles: string[];
  skippedFiles: string[];
  dryRun: boolean;
  overwrite: boolean;
}

/** Maximum directory nesting depth for template traversal. */
const MAX_TEMPLATE_DEPTH = 32;

/** Assert that a resolved path is inside the target root. */
async function assertInsideRoot(
  candidatePath: string,
  realRoot: string
): Promise<void> {
  const realCandidate = await realpath(candidatePath);
  if (!realCandidate.startsWith(realRoot + sep) && realCandidate !== realRoot) {
    throw new Error(
      'Symlink escape detected: parent directory resolves outside target root'
    );
  }
}

/**
 * Recursively process template files from source to target.
 */
export async function processFiles(
  options: ProcessFilesOptions
): Promise<ProcessFilesResult> {
  const {
    sourceDir,
    targetDir,
    context,
    ignorePatterns = [],
    dryRun = false,
    overwrite = false,
  } = options;

  const rootSource = resolve(sourceDir);
  const rootTarget = resolve(targetDir);

  // Ensure target directory exists before resolving its real path
  if (!dryRun) {
    await mkdir(rootTarget, { recursive: true });
  }

  // Compute realRoot once — it's invariant for the entire walk
  const realRoot = dryRun ? rootTarget : await realpath(rootTarget);

  const state: WalkState = {
    rootSource,
    rootTarget,
    realRoot,
    context,
    ignorePatterns: [...DEFAULT_IGNORE, ...ignorePatterns],
    createdFiles: [],
    skippedFiles: [],
    dryRun,
    overwrite,
  };

  await walkDir(rootSource, rootTarget, state);

  return { createdFiles: state.createdFiles, skippedFiles: state.skippedFiles };
}

async function walkDir(
  currentDir: string,
  currentTargetDir: string,
  state: WalkState,
  depth = 0
): Promise<void> {
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new Error(
      `Template directory nesting exceeds the maximum allowed depth (${MAX_TEMPLATE_DEPTH})`
    );
  }
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryName = entry.name;

    if (state.ignorePatterns.includes(entryName)) continue;

    const sourcePath = join(currentDir, entryName);

    // Reject source symlinks
    const entryStat = await lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      state.skippedFiles.push(relative(state.rootSource, sourcePath));
      continue;
    }

    const relPath = relative(state.rootSource, sourcePath);

    // Render filename placeholders
    const renderedName = renderFilename(entryName, state.context);
    const targetPath = join(currentTargetDir, renderedName);

    // Path traversal protection
    const resolvedTarget = resolve(targetPath);
    if (
      !resolvedTarget.startsWith(state.rootTarget + sep) &&
      resolvedTarget !== state.rootTarget
    ) {
      throw new Error(
        `Path traversal detected: '${relPath}' would write outside target directory`
      );
    }

    // Reject target symlinks
    let targetExists = false;
    try {
      const targetStat = await lstat(targetPath);
      targetExists = true;
      if (targetStat.isSymbolicLink()) {
        throw new Error(
          `Refusing to overwrite symlink at target: ${targetPath}`
        );
      }
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }

    if (entryStat.isDirectory()) {
      if (!state.dryRun) {
        await mkdir(targetPath, { recursive: true });
        // Security: validate path stays within target root (after mkdir so
        // realpath can resolve the just-created dir; catches symlink escapes).
        await assertInsideRoot(targetPath, state.realRoot);
      }
      await walkDir(sourcePath, targetPath, state, depth + 1);
    } else if (entryStat.isFile()) {
      // Skip existing files when overwrite is disabled (reuse lstat result)
      if (!state.overwrite && targetExists) {
        state.skippedFiles.push(relative(state.rootTarget, resolvedTarget));
        continue;
      }

      // Security: validate path stays within target root (even in dryRun)
      await assertInsideRoot(dirname(targetPath), state.realRoot);
      if (!state.dryRun) {
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      }
      state.createdFiles.push(relative(state.rootTarget, resolvedTarget));
    }
  }
}
