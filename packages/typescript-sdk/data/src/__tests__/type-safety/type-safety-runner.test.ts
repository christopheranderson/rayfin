import { execFile } from 'child_process';
import { createRequire } from 'module';
import { join } from 'path';
import { promisify, debuglog } from 'util';

import { describe, it, expect, beforeAll } from 'vitest';

const debug = debuglog('rayfin/tests/type-safety');

const execFileAsync = promisify(execFile);

const DATA_ROOT_PATH = join(__dirname, '..', '..', '..');

// Resolve the tsc entrypoint through this package's own dependency graph so
// we can invoke it via `node <path>` and avoid `execFile`-ing an `npx.cmd`
// shim, which fails with EINVAL on Node.js 20+ / Windows unless `shell: true`
// is set (which we intentionally do not use, to remain safe against paths
// containing spaces).
const requireFromRunner = createRequire(__filename);
const TSC_BIN = requireFromRunner.resolve('typescript/bin/tsc');

/**
 * COMPILE-TIME TYPE SAFETY REGRESSION TESTS (OPTIMIZED)
 *
 * This test suite verifies that our type safety regression test files
 * correctly fail to compile when they should, ensuring that type safety
 * regressions are caught during CI/build.
 *
 * OPTIMIZATION: Uses parallel compilation for faster execution.
 */

describe('Type Safety Regression Prevention (Optimized)', () => {
  // Consolidated test case definitions (removed duplicate 'more-typos' case)
  const testCases = [
    {
      file: 'optional-arrays-invalid-fields.ts',
      description: 'Optional Arrays with Invalid Fields (Original Bug)',
    },
    {
      file: 'optional-objects-invalid-fields.ts',
      description: 'Optional Objects with Invalid Fields',
    },
    {
      file: 'required-arrays-invalid-fields.ts',
      description: 'Required Arrays with Invalid Fields',
    },
    {
      file: 'required-objects-invalid-fields.ts',
      description: 'Required Objects with Invalid Fields',
    },
    {
      file: 'invalid-top-level-fields.ts',
      description: 'Invalid Top-Level Fields',
    },
    {
      file: 'typos-in-nested-fields.ts',
      description: 'Typos in Nested Field Names',
    },
    {
      file: 'nested-paths-to-non-objects.ts',
      description: 'Nested Paths to Non-Object Fields',
    },
    {
      file: 'aggregate-multiple-ops.ts',
      description: 'Aggregation entry with more than one operation',
    },
    {
      file: 'aggregate-sum-non-numeric.ts',
      description: 'Numeric aggregation (sum) over a non-numeric field',
    },
    {
      file: 'aggregate-count-non-numeric.ts',
      description: 'count over a non-numeric field',
    },
    {
      file: 'aggregate-unknown-field.ts',
      description: 'Aggregation references an unknown field',
    },
    {
      file: 'aggregate-after-select.ts',
      description: 'aggregate() called after select()',
    },
    {
      file: 'aggregate-after-select-where.ts',
      description: 'aggregate() called after select().where()',
    },
    {
      file: 'aggregate-after-first-where.ts',
      description: 'aggregate() called after first().where()',
    },
    {
      file: 'aggregate-after-orderby-where.ts',
      description: 'aggregate() called after orderBy().where()',
    },
    {
      file: 'aggregate-select-after-groupby.ts',
      description: 'select() called after groupBy()',
    },
    {
      file: 'groupby-after-select-where.ts',
      description: 'groupBy() called after select().where()',
    },
    {
      file: 'aggregate-grandtotal-field-access.ts',
      description: 'scalar field access on a grand-total aggregation row',
    },
    {
      file: 'datapath-relationship-sourcefields-rejected.ts',
      description:
        'sourceFields on a data-path relationship (connector-only custom FK)',
      expectedError: 'CustomKeyEntityClass',
    },
    {
      file: 'datapath-relationship-targetfields-rejected.ts',
      description:
        'targetFields on a data-path relationship (connector-only custom FK)',
      expectedError: 'CustomKeyEntityClass',
    },
    {
      file: 'datapath-relationship-both-fields-rejected.ts',
      description:
        'sourceFields + targetFields on a data-path relationship (connector-only custom FK)',
      expectedError: 'CustomKeyEntityClass',
    },
    {
      file: 'datapath-relationship-variable-fields-rejected.ts',
      description:
        'sourceFields on a data-path relationship passed via a variable (bypasses excess-property check)',
      expectedError: 'CustomKeyEntityClass',
    },
    {
      file: 'datapath-relationship-many-fields-rejected.ts',
      description:
        'sourceFields + targetFields on a data-path @many() relationship (connector-only custom FK)',
      expectedError: 'CustomKeyEntityClass',
    },
  ];

  // Store compilation results to share across all tests
  let compilationResults: Map<
    string,
    { success: boolean; error?: string; duration: number }
  >;

  // Pre-compile all test cases once before running individual tests
  beforeAll(async () => {
    const startTime = Date.now();
    debug('🚀 Pre-compiling all test cases in parallel...');

    const compilationPromises = testCases.map(async ({ file, description }) => {
      const testFilePath = join(__dirname, 'test-cases', file);
      const caseStartTime = Date.now();

      try {
        // Use execFile (no shell) so paths with spaces are passed correctly as argv entries.
        // Previously used exec() with template-interpolated paths which broke on
        // checkout paths containing spaces (e.g. "/Users/John Smith/project").
        const result = await execFileAsync(
          process.execPath,
          [
            TSC_BIN,
            '--strict',
            '--target',
            'es2022',
            '--lib',
            'ES2022,DOM,ESNext.Decorators',
            '--moduleResolution',
            'node',
            '--skipLibCheck',
            '--noEmit',
            testFilePath,
          ],
          {
            cwd: DATA_ROOT_PATH,
            windowsHide: true,
          }
        );

        console.warn(`⚠️  Unexpected success: ${description}`);
        console.warn('Stdout:', result.stdout);
        console.warn('Stderr:', result.stderr);

        // If we get here, compilation succeeded when it should have failed
        return {
          file,
          result: {
            success: false,
            error:
              'TYPE SAFETY REGRESSION DETECTED! File compiled when it should have failed.',
            duration: Date.now() - caseStartTime,
          },
        };
      } catch (e: Error | any) {
        // Compilation failed as expected - this is good!
        const output = e.stdout || e.stderr || '';
        const duration = Date.now() - caseStartTime;
        let success = true;
        let error: string = output;

        debug(`Compilation failed as expected for ${description}`);
        debug('Stdout: ', e.stdout);
        debug('Stderr: ', e.stderr);

        if (!output.trim()) {
          success = false;
          error = 'No compilation error output received';
        } else if (
          !(
            output.includes('): error TS') &&
            output.includes(`type-safety/test-cases`)
          )
        ) {
          // Check for presence of TypeScript error indicators
          success = false;
          error = `Unexpected compilation failure (no valid TS error found):\n${output}`;
        }

        return {
          file,
          result: {
            success,
            error,
            duration,
          },
        };
      }
    });

    const results = await Promise.all(compilationPromises);
    const totalTime = Date.now() - startTime;

    compilationResults = new Map();
    results.forEach(({ file, result }) => {
      compilationResults.set(file, result);
    });

    debug(
      `✅ Pre-compilation completed in ${totalTime}ms (${results.length} files)`
    );
  }, 60000); // 60 second timeout for pre-compilation

  // Individual test cases for clear failure reporting
  testCases.forEach(({ file, description, expectedError }) => {
    it(`should fail to compile: ${description}`, () => {
      const result = compilationResults.get(file);

      if (!result) {
        expect.fail(`No compilation result found for test case: ${file}`);
        return;
      }

      if (result.success) {
        // Beyond "some error occurred": when a case declares expectedError,
        // require the compiler output to name our guard type, so a case that
        // fails for an unrelated reason (typo, bad import, missing export)
        // cannot pass green.
        if (expectedError) {
          expect(result.error).toContain(expectedError);
        }
        debug(
          `✅ ${description} correctly failed to compile (${result.duration}ms)`
        );
        debug('Compilation Error Output:\n', result.error);
      } else {
        expect.fail(
          `${result.error}\n` +
            `File: ${file}\n` +
            `Description: ${description}`
        );
      }
    });
  });
});
