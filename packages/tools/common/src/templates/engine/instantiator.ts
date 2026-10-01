import type {
  InstantiationOptions,
  InstantiationResult,
  ResolvedTemplate,
} from '../types.js';

import { processFiles } from './file-processor.js';

/**
 * Full template instantiation pipeline:
 * 1. Build context from presets
 * 2. Process template files to target directory
 * 3. Return result summary
 */
export async function instantiateTemplate(
  template: ResolvedTemplate,
  options: InstantiationOptions
): Promise<InstantiationResult> {
  const {
    targetDir,
    presets = {},
    dryRun = false,
    overwrite = false,
  } = options;

  // Use presets directly as the context
  const context: Record<string, unknown> = { ...presets };

  // Process files
  const result = await processFiles({
    sourceDir: template.sourcePath,
    targetDir,
    context,
    dryRun,
    overwrite,
  });

  return {
    createdFiles: result.createdFiles,
    skippedFiles: result.skippedFiles,
    parameters: context,
    targetDir,
  };
}
