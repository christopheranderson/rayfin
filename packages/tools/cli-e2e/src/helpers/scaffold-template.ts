/**
 * Shared helpers for scaffolding templates in E2E tests.
 *
 * This module is vitest-free so it can be imported from both Vitest tests
 * and Playwright browser specs.
 */
import { exec as execCb } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { authMode } from './env.js';
import { WORKSPACE_ITEM_LIMIT_ERROR } from './fabric-api.js';
import type { CliResult } from './local-packages.js';
import { rewriteToLocalPackages, runNpmInstall } from './local-packages.js';

const exec = promisify(execCb);
const DEPLOY_CAPACITY_RETRY_DELAY_MS = 15_000;
const DEPLOY_CAPACITY_MAX_RETRIES = 5;

// ─── CLI Runner Interface ─────────────────────────────────────────────────────

/**
 * Interface for CLI runner functions. Allows injection of vitest-free
 * implementations from Playwright tests.
 */
export interface CliRunners {
  runCli: (
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
  ) => Promise<CliResult>;
  runCreateRayfin: (
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
  ) => Promise<CliResult>;
}

/**
 * Lazily load the default CLI runners from run-cli.ts.
 * This avoids importing vitest at module level so Playwright specs can
 * safely import this module (they pass their own runners).
 */
async function getDefaultRunners(): Promise<CliRunners> {
  const mod = await import('./run-cli.js');
  return { runCli: mod.runCli, runCreateRayfin: mod.runCreateRayfin };
}

// ─── Environment Guards ───────────────────────────────────────────────────────

/**
 * When USE_LOCAL_PACKAGES is set, tests scaffold with --skip-install,
 * rewrite rayfin dependencies to file: references pointing at the local
 * repo build, then run npm install. This avoids hitting the public registry
 * for rayfin packages and lets E2E tests validate against local code.
 */
export const useLocalPackages = process.env['USE_LOCAL_PACKAGES'] === 'true';

/**
 * Whether to run tests that depend on `npm install` resolving published
 * SDK packages. Skipped on version-bump PRs where new versions haven't
 * been published yet.
 */
export const runRegistryDependent =
  useLocalPackages || process.env['RUN_REGISTRY_DEPENDENT_E2E'] !== 'false';

// ─── Template Scaffolding ─────────────────────────────────────────────────────

/**
 * Scaffold a template and optionally install deps using the useLocalPackages
 * pattern. Reusable across all init/* and fabric tests.
 *
 * Pass `runners` to inject vitest-free CLI implementations (e.g. from
 * Playwright helpers). If omitted, defaults to the runners from run-cli.ts
 * (loaded lazily).
 */
export async function scaffoldTemplate(opts: {
  template: string;
  dialect?: string;
  projectName: string;
  cwd: string;
  install?: boolean;
  runners?: CliRunners;
}): Promise<{
  projectDir: string;
  initResult: { exitCode: number; output: string };
}> {
  const { runCli } = opts.runners ?? (await getDefaultRunners());

  const initResult = await runCli(
    [
      'init',
      '--template',
      opts.template,
      ...(opts.dialect ? ['--dialect', opts.dialect] : []),
      '--project-name',
      opts.projectName,
      '--skip-install',
      opts.projectName,
    ],
    { cwd: opts.cwd }
  );

  const projectDir = join(opts.cwd, opts.projectName);

  if (opts.install && initResult.exitCode === 0) {
    if (useLocalPackages) {
      rewriteToLocalPackages(projectDir);
    }
    const installResult = await runNpmInstall(projectDir);
    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed:\n${installResult.output}`);
    }
  }

  return { projectDir, initResult };
}

// ─── Entity Generation ────────────────────────────────────────────────────────

/**
 * Generate a minimal entity class source with uuid `id` and text `name`.
 */
export function makeEntitySource(className: string): string {
  return [
    "import { entity, uuid, text } from '@microsoft/rayfin-core';",
    '',
    '@entity()',
    `export class ${className} {`,
    '  @uuid() id!: string;',
    '  @text() name!: string;',
    '}',
    '',
  ].join('\n');
}

// ─── Compilation Utilities ────────────────────────────────────────────────────

/**
 * Self-contained tsconfig for the rayfin/ directory that avoids inheriting
 * `allowImportingTsExtensions` from the parent tsconfig (which triggers
 * TS5096 in TypeScript 5.8+ when `noEmit` is false).
 */
export const RAYFIN_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'ESNext.Decorators'],
      useDefineForClassFields: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      moduleDetection: 'force',
      isolatedModules: true,
      outDir: '.temp/compiled',
      rootDir: '.',
      declaration: true,
      composite: true,
      strictNullChecks: true,
      skipLibCheck: true,
    },
    include: ['**/*'],
    exclude: ['.temp/**/*'],
  },
  null,
  2
);

/**
 * Compile the rayfin directory, replicating the CLI's behavior of cleaning
 * .temp/compiled before running tsc.
 */
export async function compileRayfin(
  projectDir: string
): Promise<{ exitCode: number; output: string }> {
  const compiledDir = join(projectDir, 'rayfin', '.temp', 'compiled');
  if (existsSync(compiledDir)) {
    rmSync(compiledDir, { recursive: true, force: true });
  }

  try {
    const { stdout, stderr } = await exec('npx tsc -p rayfin/tsconfig.json', {
      cwd: projectDir,
      timeout: 60_000,
    });
    return { exitCode: 0, output: stdout + stderr };
  } catch (err: any) {
    return {
      exitCode: err.code ?? 1,
      output: (err.stdout ?? '') + (err.stderr ?? ''),
    };
  }
}

/**
 * List compiled .js files in the rayfin/.temp/compiled/data directory.
 */
export function listCompiledDataFiles(projectDir: string): string[] {
  const compiledDataDir = join(
    projectDir,
    'rayfin',
    '.temp',
    'compiled',
    'data'
  );
  if (!existsSync(compiledDataDir)) return [];
  return readdirSync(compiledDataDir)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

// ─── Fabric Deployment Workflow ───────────────────────────────────────────────

export interface FabricDeployOptions {
  config: {
    clientId?: string;
    clientSecret?: string;
    tenantId: string;
    artifactName: string;
    artifactId: string;
    workspaceId: string;
    workspaceName: string;
    baseApiUrl: string;
  };
  tempDir: string;
  template?: string;
  dialect?: string;
  artifactSuffix?: string;
  beforeDeploy?: (projectDir: string) => void | Promise<void>;
  runners?: CliRunners;
}

export interface FabricDeployResult {
  projectDir: string;
}

/**
 * Login, scaffold a template into a Fabric workspace, optionally rewrite
 * to local packages, install deps, and deploy with `rayfin up`.
 *
 * In `sp` auth mode, performs service principal login via the CLI.
 * In `user` auth mode, verifies that a prior `rayfin login` session exists
 * (the user must have authenticated interactively before running tests).
 */
export async function loginScaffoldAndDeploy(
  opts: FabricDeployOptions
): Promise<FabricDeployResult> {
  const { config, tempDir } = opts;
  const { runCli, runCreateRayfin } =
    opts.runners ?? (await getDefaultRunners());
  const template = opts.template ?? 'todoapp';
  const artifactName = opts.artifactSuffix
    ? `${config.artifactName}-${opts.artifactSuffix}`
    : config.artifactName;

  // Step 1: Authenticate
  if (authMode === 'user') {
    // User mode — the global setup should have already triggered login.
    // Verify the session is valid; if not, provide a clear error.
    const statusResult = await runCli(['login', 'status'], { cwd: tempDir });
    if (
      statusResult.exitCode !== 0 ||
      !statusResult.output.includes('Signed in')
    ) {
      throw new Error(
        'E2E_AUTH_MODE=user but no active login session found.\n' +
          'The global setup should have triggered interactive login.\n' +
          'Try running manually: rayfin login --tenant <your-tenant-id>\n' +
          `Status output:\n${statusResult.output}`
      );
    }
  } else {
    // SP mode — login with service principal credentials
    const loginResult = await runCli(
      [
        'login',
        '--service-principal',
        '--client-id',
        config.clientId!,
        '--client-secret',
        config.clientSecret!,
        '--tenant',
        config.tenantId,
        '--encryption-fallback-enabled',
      ],
      { cwd: tempDir }
    );
    if (loginResult.exitCode !== 0) {
      throw new Error(`Login failed:\n${loginResult.output}`);
    }
  }

  // Step 2: Scaffold the template with the pre-created Fabric artifact
  const createArgs = [
    artifactName,
    '--template',
    template,
    ...(opts.dialect ? ['--dialect', opts.dialect] : []),
    '--workspace-id',
    config.workspaceId,
    '--item-id',
    config.artifactId,
    '--base-api-url',
    config.baseApiUrl,
    ...(useLocalPackages ? ['--skip-install'] : []),
  ];
  const createResult = await runCreateRayfin(createArgs, {
    cwd: tempDir,
    timeoutMs: 120_000,
  });
  if (createResult.exitCode !== 0) {
    throw new Error(`Scaffold failed:\n${createResult.output}`);
  }

  const projectDir = join(tempDir, artifactName);

  // Step 3: Rewrite rayfin deps to local file: references and install
  if (useLocalPackages) {
    rewriteToLocalPackages(projectDir);
    const installResult = await runNpmInstall(projectDir);
    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed:\n${installResult.output}`);
    }
  }

  await opts.beforeDeploy?.(projectDir);

  // Step 4: Deploy with rayfin up. Fabric releases child SQL item slots
  // asynchronously after stale AppBackends are deleted, so retry only that
  // exact capacity response while cleanup finishes.
  let upResult: CliResult | undefined;
  for (let attempt = 0; attempt <= DEPLOY_CAPACITY_MAX_RETRIES; attempt++) {
    upResult = await runCli(
      ['up', '--workspace', config.workspaceName, '-y', '--verbose'],
      {
        cwd: projectDir,
        timeoutMs: 120_000,
      }
    );
    if (upResult.exitCode === 0) break;
    if (
      !upResult.output.includes(WORKSPACE_ITEM_LIMIT_ERROR) ||
      attempt === DEPLOY_CAPACITY_MAX_RETRIES
    ) {
      throw new Error(`rayfin up failed:\n${upResult.output}`);
    }

    console.log(
      `[cli-e2e] Fabric workspace item cleanup is still in progress; retrying deployment in ${DEPLOY_CAPACITY_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${DEPLOY_CAPACITY_MAX_RETRIES}).`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, DEPLOY_CAPACITY_RETRY_DELAY_MS)
    );
  }

  return { projectDir };
}

// ─── Deployment Validation Utilities ──────────────────────────────────────────

export interface DeploymentInfo {
  active: string;
  deployment: Record<string, unknown>;
}

/**
 * Parse the `.deployments.json` registry from a scaffolded project and return
 * the active deployment entry.
 */
export function parseDeploymentsRegistry(projectDir: string): DeploymentInfo {
  const registryPath = join(projectDir, 'rayfin', '.deployments.json');
  if (!existsSync(registryPath)) {
    throw new Error(`.deployments.json not found at ${registryPath}`);
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const activeName: string = registry.active;
  const deployment = registry.deployments[activeName];
  return { active: activeName, deployment };
}

/**
 * Parse the `rayfin/.env` file and return a Map of key-value pairs.
 */
export function parseRayfinEnvVars(projectDir: string): Map<string, string> {
  const envPath = join(projectDir, 'rayfin', '.env');
  if (!existsSync(envPath)) {
    throw new Error(`rayfin/.env not found at ${envPath}`);
  }
  const envContent = readFileSync(envPath, 'utf8');
  return new Map(
    envContent
      .split('\n')
      .filter((line: string) => line.includes('='))
      .map((line: string) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1)] as [string, string];
      })
  );
}
