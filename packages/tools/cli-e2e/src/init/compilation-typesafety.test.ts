import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createTempDir, useTrackedCleanup } from '../helpers/run-cli.js';
import {
  compileRayfin,
  listCompiledDataFiles,
  makeEntitySource,
  RAYFIN_TSCONFIG,
  runRegistryDependent,
  scaffoldTemplate,
} from '../helpers/scaffold-template.js';

const { track: trackCleanup } = useTrackedCleanup();

// ─── @one() relationship type safety ──────────────────────────────────────────

describe('@one() relationship type safety', { timeout: 300_000 }, () => {
  it.skipIf(!runRegistryDependent)(
    '@one() relationship decorator does not throw TS2322 EntityClass type error',
    async () => {
      const tmp = createTempDir();
      trackCleanup(tmp.cleanup);

      // Scaffold a dataapp template locally (no Fabric deployment needed for type check)
      const { projectDir, initResult } = await scaffoldTemplate({
        template: 'dataapp',
        dialect: 'mssql',
        projectName: 'one-relationship-ts',
        cwd: tmp.dir,
        install: true,
      });

      expect(initResult.exitCode).toBe(0);

      // Overwrite rayfin/tsconfig.json with self-contained config
      // to avoid inheriting allowImportingTsExtensions from parent tsconfig
      writeFileSync(
        join(projectDir, 'rayfin', 'tsconfig.json'),
        RAYFIN_TSCONFIG
      );

      // Add entity files with @one() relationship
      const dataDir = join(projectDir, 'rayfin', 'data');
      mkdirSync(dataDir, { recursive: true });

      writeFileSync(
        join(dataDir, 'Category.ts'),
        [
          "import { entity, uuid, text } from '@microsoft/rayfin-core';",
          '',
          '@entity()',
          'export class Category {',
          '  @uuid() id!: string;',
          '  @text() name!: string;',
          '}',
          '',
        ].join('\n'),
        'utf8'
      );

      writeFileSync(
        join(dataDir, 'Asset.ts'),
        [
          "import { entity, uuid, text, one } from '@microsoft/rayfin-core';",
          "import { Category } from './Category.js';",
          '',
          '@entity()',
          'export class Asset {',
          '  @uuid() id!: string;',
          '  @text() title!: string;',
          '',
          '  @one(() => Category, { optional: true })',
          '  category?: Category;',
          '}',
          '',
        ].join('\n'),
        'utf8'
      );

      // Compile the rayfin directory — this validates no TS2322 type errors
      const compileResult = await compileRayfin(projectDir);

      console.log('compile output:', compileResult.output);

      expect(
        compileResult.exitCode,
        `TypeScript compilation failed (TS2322 or other error):\n${compileResult.output}`
      ).toBe(0);

      // Verify compiled output exists for both entities
      const compiledFiles = listCompiledDataFiles(projectDir);
      expect(compiledFiles).toContain('Category.js');
      expect(compiledFiles).toContain('Asset.js');
    }
  );
});

// ─── Rayfin compile stale cache invalidation ──────────────────────────────────

describe(
  'rayfin compile stale cache invalidation',
  { timeout: 180_000 },
  () => {
    it.skipIf(!runRegistryDependent)(
      'newly added entity files are detected without manual .temp/ deletion',
      async () => {
        const tmp = createTempDir();
        trackCleanup(tmp.cleanup);

        const { projectDir, initResult } = await scaffoldTemplate({
          template: 'dataapp',
          dialect: 'mssql',
          projectName: 'stale-cache-test',
          cwd: tmp.dir,
          install: true,
        });

        expect(initResult.exitCode).toBe(0);

        const dataDir = join(projectDir, 'rayfin', 'data');
        mkdirSync(dataDir, { recursive: true });

        // Overwrite rayfin/tsconfig.json with self-contained config
        writeFileSync(
          join(projectDir, 'rayfin', 'tsconfig.json'),
          RAYFIN_TSCONFIG
        );

        // Step 1: Add 2 initial entities (Asset.ts, Liability.ts)
        writeFileSync(join(dataDir, 'Asset.ts'), makeEntitySource('Asset'));
        writeFileSync(
          join(dataDir, 'Liability.ts'),
          makeEntitySource('Liability')
        );

        // Step 2: First compilation
        const firstRun = await compileRayfin(projectDir);

        expect(
          firstRun.exitCode,
          `First compilation failed:\n${firstRun.output}`
        ).toBe(0);

        const firstFiles = listCompiledDataFiles(projectDir);
        expect(firstFiles).toContain('Asset.js');
        expect(firstFiles).toContain('Liability.js');

        // Step 3: Add 2 MORE entity files (Category.ts, Transaction.ts)
        writeFileSync(
          join(dataDir, 'Category.ts'),
          makeEntitySource('Category')
        );
        writeFileSync(
          join(dataDir, 'Transaction.ts'),
          makeEntitySource('Transaction')
        );

        // Step 4: Second compilation WITHOUT manual cache deletion
        const secondRun = await compileRayfin(projectDir);

        expect(
          secondRun.exitCode,
          `Second compilation failed:\n${secondRun.output}`
        ).toBe(0);

        // After adding new entity files and recompiling, the scanner should
        // find ALL entities — not just the ones from the previous compilation
        // run (stale cache).
        const secondFiles = listCompiledDataFiles(projectDir);
        expect(
          secondFiles,
          [
            'After adding new entity files and recompiling,',
            'the scanner should find ALL entities — not just the ones from',
            'the previous compilation run (stale cache).',
            '',
            `Expected: Asset.js, Category.js, Liability.js, Transaction.js`,
            `Found: ${secondFiles.join(', ')}`,
          ].join('\n')
        ).toContain('Category.js');
        expect(secondFiles).toContain('Transaction.js');
        expect(secondFiles).toContain('Asset.js');
        expect(secondFiles).toContain('Liability.js');
        expect(secondFiles).toHaveLength(4);
      }
    );
  }
);
