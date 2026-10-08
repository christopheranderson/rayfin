import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  type CliResult,
  rewriteToLocalPackages,
  runNpmInstall,
} from './local-packages.js';
import { type CliRunners, useLocalPackages } from './scaffold-template.js';

/**
 * Assert the generated runtime pin before replacing it with a local package.
 * The second init must not use --force, which would restore the registry pin.
 */
export async function initFunctions(opts: {
  projectDir: string;
  force?: boolean;
  path?: string;
  runners?: Pick<CliRunners, 'runCli'>;
}): Promise<CliResult> {
  const runCli = opts.runners?.runCli ?? (await import('./run-cli.js')).runCli;
  const args = [
    'functions',
    'init',
    ...(opts.force ? ['--force'] : []),
    ...(opts.path ? ['--path', opts.path] : []),
  ];
  const runOptions = { cwd: opts.projectDir, timeoutMs: 300_000 };

  if (!useLocalPackages) {
    return runCli(args, runOptions);
  }

  const scaffoldResult = await runCli([...args, '--skip-install'], runOptions);
  if (scaffoldResult.exitCode !== 0) return scaffoldResult;

  const config = parseYaml(
    readFileSync(join(opts.projectDir, 'rayfin', 'rayfin.yml'), 'utf8')
  ) as { services?: { functions?: { path?: string } } };
  const functionsDir = resolve(
    opts.projectDir,
    config.services?.functions?.path ?? 'rayfin/functions'
  );
  const pkg = JSON.parse(
    readFileSync(join(functionsDir, 'package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };
  const versionResult = await runCli(['--version'], runOptions);
  if (versionResult.exitCode !== 0) {
    throw new Error(`CLI version lookup failed:\n${versionResult.output}`);
  }
  const version = versionResult.stdout.trim().split(/\s+/)[0];
  const workerVersion =
    pkg.dependencies?.['@microsoft/fabric-user-data-functions'];
  if (!version || workerVersion !== version) {
    throw new Error(
      `Expected Functions worker to be pinned to CLI version "${version}", got "${workerVersion}".`
    );
  }

  const rootPkgPath = join(opts.projectDir, 'package.json');
  const rootPkg = existsSync(rootPkgPath)
    ? (JSON.parse(readFileSync(rootPkgPath, 'utf8')) as {
        workspaces?: unknown;
      })
    : undefined;
  const workspaceRoot = rootPkg?.workspaces ? opts.projectDir : undefined;
  rewriteToLocalPackages(functionsDir, { workspaceRoot });
  if (workspaceRoot) {
    // Establish local links from the workspace root before init runs npm in
    // the member package. A fresh member-only install can leave broken links.
    const installResult = await runNpmInstall(workspaceRoot);
    if (installResult.exitCode !== 0) return installResult;
  }

  return runCli(['functions', 'init'], runOptions);
}
