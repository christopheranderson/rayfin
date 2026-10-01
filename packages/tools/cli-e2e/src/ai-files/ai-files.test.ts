import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createTempDir,
  runCli,
  useTrackedCleanup,
} from '../helpers/run-cli.js';

const { track: trackCleanup } = useTrackedCleanup();

/**
 * Scaffold a minimal Rayfin project for ai-files commands to operate on.
 */
function scaffoldProject(dir: string): string {
  const projectDir = join(dir, 'ai-test-app');
  mkdirSync(join(projectDir, 'rayfin'), { recursive: true });

  writeFileSync(
    join(projectDir, 'rayfin', 'rayfin.yml'),
    'id: ai-test-app\nname: ai-test-app\nservices:\n  data:\n    enabled: true\n',
    'utf8'
  );

  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'ai-test-app', version: '1.0.0' }, null, 2),
    'utf8'
  );

  return projectDir;
}

describe('rayfin init ai-files install', () => {
  it('installs agent files into a scaffolded project', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    const result = await runCli(
      ['init', 'ai-files', 'install', '--non-interactive'],
      { cwd: projectDir }
    );

    expect(result.exitCode).toBe(0);

    // AGENTS.md should be created
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(true);

    // .mcp.json should be created with rayfin entry
    const mcpPath = join(projectDir, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const mcpContent = readFileSync(mcpPath, 'utf8');
    expect(mcpContent).toContain('rayfin');

    // Lockfile should be created
    const lockfilePath = join(projectDir, 'rayfin', '.lockfile.json');
    expect(existsSync(lockfilePath)).toBe(true);
  });

  it('is idempotent — re-running succeeds without errors', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    // First install
    await runCli(['init', 'ai-files', 'install', '--non-interactive'], {
      cwd: projectDir,
    });

    // Second install — should succeed
    const result = await runCli(
      ['init', 'ai-files', 'install', '--non-interactive'],
      { cwd: projectDir }
    );

    expect(result.exitCode).toBe(0);
  });

  it('respects --json flag', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    const result = await runCli(
      ['init', 'ai-files', 'install', '--non-interactive', '--json'],
      { cwd: projectDir }
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('status');
  });

  it('respects --dry-run without writing files', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    const result = await runCli(
      ['init', 'ai-files', 'install', '--non-interactive', '--dry-run'],
      { cwd: projectDir }
    );

    expect(result.exitCode).toBe(0);

    // Files should NOT have been created
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false);
  });
});

describe('rayfin init ai-files status', () => {
  it('reports status after install', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    // Install first
    await runCli(['init', 'ai-files', 'install', '--non-interactive'], {
      cwd: projectDir,
    });

    // Check status
    const result = await runCli(['init', 'ai-files', 'status'], {
      cwd: projectDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('up-to-date');
  });

  it('reports status as JSON', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    // Install first
    await runCli(['init', 'ai-files', 'install', '--non-interactive'], {
      cwd: projectDir,
    });

    // Check status with --json
    const result = await runCli(['init', 'ai-files', 'status', '--json'], {
      cwd: projectDir,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('items');
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
  });

  it('reports missing state when no install has run', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = scaffoldProject(tmp.dir);

    const result = await runCli(['init', 'ai-files', 'status'], {
      cwd: projectDir,
    });

    expect(result.exitCode).toBe(0);
    // Should report items as not-installed (no install has run yet)
    expect(result.output).toMatch(/not-installed/i);
  });
});
