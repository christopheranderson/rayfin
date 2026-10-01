import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { stringify } from 'yaml';

export interface TestTemplateOptions {
  name?: string;
  files?: Record<string, string>;
}

export interface TestTemplate {
  /** Absolute path to the template directory */
  path: string;
  /** file:// URL suitable for `--template` flag (git-compatible) */
  fileUrl: string;
  /** Stage and commit all changes in the template repo */
  commitChanges: (message: string) => void;
  /** Clean up the temp directory */
  cleanup: () => void;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'E2E Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

/**
 * Create a minimal template git repo in a temp directory.
 * The template has a valid `rayfin-template.yml` manifest
 * and at least one entry pointing to `.`.
 */
export function createTestTemplate(
  options?: TestTemplateOptions
): TestTemplate {
  const name = options?.name ?? 'test-template';
  const tempDir = mkdtempSync(join(tmpdir(), `rayfin-e2e-tpl-`));

  // Write manifest
  const manifest = {
    apiVersion: 'v1',
    metadata: {
      name,
      displayName: `Test Template: ${name}`,
      description: 'E2E test template',
    },
    entries: [{ name, path: '.' }],
  };
  writeFileSync(join(tempDir, 'rayfin-template.yml'), stringify(manifest));

  // Write default files or custom files
  const files = options?.files ?? {
    'package.json': JSON.stringify(
      { name: '{{projectName}}', version: '1.0.0' },
      null,
      2
    ),
    'src/index.ts': '// Hello from test template\n',
  };

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(tempDir, filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // Initialize a git repo (required for file:// URL cloning)
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], {
    cwd: tempDir,
    stdio: 'ignore',
    env: GIT_ENV,
  });

  const fileUrl = pathToFileURL(tempDir).href;

  const commitChanges = (message: string): void => {
    execFileSync('git', ['add', '-A'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message], {
      cwd: tempDir,
      stdio: 'ignore',
      env: GIT_ENV,
    });
  };

  return {
    path: tempDir,
    fileUrl,
    commitChanges,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort
      }
    },
  };
}
