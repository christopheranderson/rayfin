import fs from 'fs';
import { join } from 'path';

import ts from 'typescript';

/**
 * A TypeScript {@link ts.Program} for a Rayfin functions project plus its
 * {@link ts.TypeChecker}. Building the program is the expensive step, so
 * callers that need both metadata and type resolution should create it once
 * and share it.
 */
export interface FunctionsProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
}

/**
 * Create a {@link ts.Program} from a functions project's `tsconfig.json`.
 *
 * Returns `null` when the project has no `tsconfig.json` or the config cannot
 * be parsed, letting callers fall back to per-file, text-only parsing
 * (`ts.createSourceFile`) so metadata generation still works on minimal
 * projects.
 */
export function createFunctionsProgram(
  functionsDir: string
): FunctionsProgram | null {
  const tsconfigPath = join(functionsDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) return null;

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    functionsDir
  );
  if (parsed.errors.length > 0 || parsed.fileNames.length === 0) return null;

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  return { program, checker };
}

/**
 * Decide whether a source file is a user-authored functions file that should
 * be scanned for `udf.func()` registrations.
 *
 * Mirrors the glob ignore list used by the legacy per-file parser
 * (`**\/*.d.ts`, `**\/*.test.ts`, `**\/*.spec.ts`, `**\/types.ts`) and scopes
 * to the project's `src/` directory so the program's lib and dependency
 * `.d.ts` files (and anything outside `src/`) are excluded.
 *
 * @param sourceFile - A source file from {@link ts.Program.getSourceFiles}.
 * @param srcDirNormalized - Absolute path to the project's `src/` directory,
 *   with backslashes normalized to forward slashes.
 */
export function isFunctionSourceFile(
  sourceFile: ts.SourceFile,
  srcDirNormalized: string
): boolean {
  if (sourceFile.isDeclarationFile) return false;

  const normalized = sourceFile.fileName.replace(/\\/g, '/');
  const srcPrefix = srcDirNormalized.endsWith('/')
    ? srcDirNormalized
    : `${srcDirNormalized}/`;
  if (!normalized.startsWith(srcPrefix)) return false;

  const base = normalized.split('/').pop() ?? '';
  if (base === 'types.ts') return false;
  if (/\.(test|spec)\.ts$/.test(base)) return false;

  return true;
}
