/**
 * Auto-patches `src/services/rayfinClient.ts` and `src/services/bootstrap.ts`
 * to wire `functionsBaseUrl` through to the RayfinClient constructor.
 *
 * Called on the first `rayfin dev functions apply`. Idempotent — skips if the
 * files already reference `functionsBaseUrl`. Falls back to manual instructions
 * when the file structure doesn't match the known template pattern.
 */
import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { join, relative } from 'path';

export interface PatchResult {
  /** True when both files were successfully patched this invocation. */
  patched: boolean;
  /** True when auto-patch could not be applied and the user needs manual steps. */
  manual: boolean;
  /** Relative paths of files that were modified (empty when not patched). */
  files: string[];
}

/**
 * Regex matching the `RayfinClientConfig` interface closing property.
 * Captures the last property line (`localDev: boolean;`) with its indentation
 * so we can insert `functionsBaseUrl` after it, before the closing brace.
 *
 * Tolerates:
 * - 2 or 4 space indentation
 * - Optional JSDoc comment above localDev
 * - Standard template output and minor reformats
 */
const INTERFACE_PATTERN = /(localDev: boolean;\s*\n)((\s*)\})/;

/**
 * Regex matching the `new RayfinClient<...>({ ... })` constructor body.
 * Looks for `authStorage: true` as the last property before the closing `})`.
 *
 * Tolerates:
 * - Optional trailing comma after `true`
 * - 2–6 space indentation
 */
const CONSTRUCTOR_PATTERN = /(authStorage: true,?\s*\n)(\s*\}\))/;

/**
 * Regex matching the `initRayfinClient({ ... })` call in bootstrap.ts.
 * Looks for `localDev,` as the last property before the closing `})`.
 *
 * Tolerates:
 * - Optional trailing comma after `localDev`
 * - 2–6 space indentation
 */
const BOOTSTRAP_PATTERN = /(localDev,?\s*\n)(\s*\}\))/;

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Writes `content` to `filePath` atomically by writing to a temp file first
 * and then renaming it into place. If the write or rename fails, the temp file
 * is removed so we don't leave an orphaned `.tmp` next to the target.
 */
async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {
      // Best-effort cleanup; the temp file may never have been created.
    });
    throw error;
  }
}

export async function patchClientForFunctions(
  projectRoot: string
): Promise<PatchResult> {
  const clientPath = join(projectRoot, 'src', 'services', 'rayfinClient.ts');
  const bootstrapPath = join(projectRoot, 'src', 'services', 'bootstrap.ts');

  // ── Read both files ──────────────────────────────────────────────────
  const clientContent = await tryReadFile(clientPath);
  if (clientContent === null) {
    return { patched: false, manual: true, files: [] };
  }

  // Already wired — nothing to do (silent success).
  if (clientContent.includes('functionsBaseUrl')) {
    return { patched: false, manual: false, files: [] };
  }

  const bootstrapContent = await tryReadFile(bootstrapPath);
  if (bootstrapContent === null) {
    return { patched: false, manual: true, files: [] };
  }

  // Also check bootstrap — if it's already wired independently, skip.
  if (bootstrapContent.includes('functionsBaseUrl')) {
    return { patched: false, manual: false, files: [] };
  }

  // ── Validate both files match expected patterns BEFORE writing ─────
  if (!INTERFACE_PATTERN.test(clientContent)) {
    return { patched: false, manual: true, files: [] };
  }
  if (!CONSTRUCTOR_PATTERN.test(clientContent)) {
    return { patched: false, manual: true, files: [] };
  }
  if (!BOOTSTRAP_PATTERN.test(bootstrapContent)) {
    return { patched: false, manual: true, files: [] };
  }

  // ── Apply patches ─────────────────────────────────────────────────
  const patchedClient = clientContent
    .replace(INTERFACE_PATTERN, '$1$3  functionsBaseUrl?: string;\n$2')
    .replace(
      CONSTRUCTOR_PATTERN,
      '$1    functionsBaseUrl: config.functionsBaseUrl,\n$2'
    );

  const patchedBootstrap = bootstrapContent.replace(
    BOOTSTRAP_PATTERN,
    '$1    functionsBaseUrl:\n' +
      '      import.meta.env.DEV\n' +
      '        ? import.meta.env.VITE_RAYFIN_FUNCTIONS_URL\n' +
      '        : undefined,\n$2'
  );

  // ── Write both files ─────────────────────────────────────
  await writeFileAtomic(clientPath, patchedClient);
  await writeFileAtomic(bootstrapPath, patchedBootstrap);

  return {
    patched: true,
    manual: false,
    files: [
      relative(projectRoot, clientPath),
      relative(projectRoot, bootstrapPath),
    ],
  };
}
