import { describe, it, expect } from 'vitest';

import { createTempDir, useTrackedCleanup } from '../helpers/run-cli.js';
import {
  runRegistryDependent,
  scaffoldTemplate,
} from '../helpers/scaffold-template.js';

const { track: trackCleanup } = useTrackedCleanup();

describe('todoapp template RayfinClient config', () => {
  it.skipIf(!runRegistryDependent)(
    'todoapp template compiles without TS2353 errors',
    async () => {
      const tmp = createTempDir();
      trackCleanup(tmp.cleanup);

      const { projectDir, initResult } = await scaffoldTemplate({
        template: 'todoapp',
        dialect: 'mssql',
        projectName: 'todoapp-compile-check',
        cwd: tmp.dir,
        install: true,
      });

      expect(initResult.exitCode).toBe(0);

      // Run tsc -b (the same command a user would run after scaffolding)
      const { exec: execCb } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execCb);

      const tscResult = await exec('npx tsc -b', {
        cwd: projectDir,
        timeout: 60_000,
      }).catch((err: any) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: err.code ?? 1,
      }));

      const output =
        (tscResult as any).stdout + ((tscResult as any).stderr ?? '');
      const exitCode = (tscResult as any).exitCode ?? 0;

      // No TS2353 about unknown properties
      expect(
        exitCode,
        [
          'TypeScript compilation failed after scaffolding todoapp:',
          output,
          '',
          "If TS2353 mentions 'functionsBaseUrl', the template passes a property",
          'that does not exist on RayfinClientConfig.',
        ].join('\n')
      ).toBe(0);

      expect(output).not.toMatch(/functionsBaseUrl/);
      expect(output).not.toMatch(/TS2353/);
    }
  );
});
