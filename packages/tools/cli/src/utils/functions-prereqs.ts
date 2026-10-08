import { spawnSync } from 'child_process';
import { platform } from 'os';

import inquirer from 'inquirer';

import { isInteractive } from './output-mode.js';
import { spawnSyncSafe } from './platform-utils.js';

/** A host-installable prerequisite detected by {@link inspectFunctionsPrereqs}. */
export interface PrereqStatus {
  /** Human-friendly display name for log lines. */
  name: string;
  /** Executable resolved on the user's PATH (e.g. `'node'`, `'func'`). */
  command: string;
  /** Detected version string when present, or `null` when not installed. */
  version: string | null;
  /** Minimum required major version, where applicable. */
  minimumMajor?: number;
  /** True when {@link version} satisfies the minimum constraint. */
  ok: boolean;
}

/** Per-prerequisite install plan entry presented to the user before any state change. */
export interface InstallStep {
  /** Display label, e.g. `'Azure Functions Core Tools'`. */
  name: string;
  /** Source/registry/repo the install pulls from, for the consent prompt. */
  source: string;
  /** Resolved command to execute. */
  command: string;
  /** Argument list passed to the command. */
  args: readonly string[];
  /** Short rationale shown to the user. */
  description: string;
}

/** Aggregated result of {@link inspectFunctionsPrereqs}. */
export interface FunctionsPrereqsReport {
  node: PrereqStatus;
  funcCoreTools: PrereqStatus;
}

const NODE_MIN_MAJOR = 20;

/**
 * Parse the leading semver-shaped major from a `--version` output string.
 *
 * Tolerant of leading `v`, surrounding whitespace, and trailing pre-release
 * tags (`-rc.1`, etc.). Returns `null` when no major can be extracted.
 */
function parseMajor(version: string): number | null {
  const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * Run a `--version` check against a host binary. Returns the trimmed stdout
 * (first non-empty line) when the binary exists and exits zero, or `null`
 * `func --version` is the cheapest probe for whether Azure Functions Core
 * Tools is installed. Returns the first non-empty line of stdout, or `null`
 * when it is not on the user's PATH or the call fails.
 *
 * Uses {@link spawnSyncSafe} which resolves Windows `.cmd` shims (e.g.
 * `func.cmd`) via PATHEXT — a bare `spawnSync('func', …)` with
 * `shell: false` returns ENOENT on Windows even when Core Tools is
 * installed correctly. The argument list is a fixed `['--version']`
 * (no user-supplied input), so shell injection is not a concern.
 */
function tryReadVersion(command: string): string | null {
  try {
    const result = spawnSyncSafe(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const stdout = String(result.stdout ?? '').trim();
    // `func --version` prints just the version on a single line, but other
    // tools may print banner lines first. Pick the first non-empty line.
    const firstLine = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return firstLine ?? null;
  } catch {
    return null;
  }
}

/**
 * Inspect the host for the prerequisites needed to run the local Rayfin
 * functions runtime under Azure Functions Core Tools.
 */
export function inspectFunctionsPrereqs(): FunctionsPrereqsReport {
  const nodeVersion = process.version; // always present
  const nodeMajor = parseMajor(nodeVersion);
  const node: PrereqStatus = {
    name: 'Node.js',
    command: 'node',
    version: nodeVersion,
    minimumMajor: NODE_MIN_MAJOR,
    ok: nodeMajor !== null && nodeMajor >= NODE_MIN_MAJOR,
  };

  const funcVersion = tryReadVersion('func');
  const funcCoreTools: PrereqStatus = {
    name: 'Azure Functions Core Tools',
    command: 'func',
    version: funcVersion,
    ok: funcVersion !== null,
  };

  return { node, funcCoreTools };
}

/**
 * Build the platform-appropriate install plan for any missing prerequisites.
 *
 * Node.js is intentionally **not** installed by this CLI — bumping the host
 * Node version is far too invasive to do automatically. Only Azure Functions
 * Core Tools is auto-installable here, with a separate prompt for each step
 * (no batch consent).
 *
 * Returns an empty array when nothing needs installing.
 */
export function planFunctionsInstall(
  report: FunctionsPrereqsReport
): InstallStep[] {
  const steps: InstallStep[] = [];
  if (!report.funcCoreTools.ok) {
    steps.push(...resolveCoreToolsInstall());
  }
  return steps;
}

function resolveCoreToolsInstall(): InstallStep[] {
  const description =
    'Required to run the Rayfin functions runtime locally via `func start`.';
  switch (platform()) {
    case 'win32':
      // Prefer winget (preinstalled on Windows 11 / Win Server 2022+).
      // The consent prompt is the *only* point of authorisation — we never
      // silently install. `--accept-source-agreements --accept-package-agreements`
      // suppresses winget's own confirmation prompts (the user has already
      // consented in our prompt).
      //
      // Note: the canonical winget id is `Microsoft.Azure.FunctionsCoreTools`
      // (with a dot between Azure and Functions). `Microsoft.AzureFunctionsCoreTools`
      // looks plausible but is NOT registered — winget will report
      // "No package found matching input criteria" *after* a download
      // progress bar that suggests success.
      return [
        {
          name: 'Azure Functions Core Tools (winget)',
          source: 'Microsoft via winget',
          command: 'winget',
          args: [
            'install',
            '--id',
            'Microsoft.Azure.FunctionsCoreTools',
            '--source',
            'winget',
            '--accept-package-agreements',
            '--accept-source-agreements',
          ],
          description,
        },
      ];
    case 'darwin':
      return [
        {
          name: 'Azure Functions Core Tools tap (Homebrew)',
          source: 'Homebrew',
          command: 'brew',
          args: ['tap', 'azure/functions'],
          description:
            'Register the Azure Functions Homebrew tap before installing Core Tools.',
        },
        {
          name: 'Azure Functions Core Tools (Homebrew)',
          source: 'Homebrew',
          command: 'brew',
          args: ['install', 'azure-functions-core-tools@4'],
          description,
        },
      ];
    default:
      // Linux fallback: npm global install. The official Microsoft apt repo
      // requires root + repo configuration, which is too invasive to do
      // from a CLI consent prompt. The npm route is portable and reverses
      // cleanly with `npm uninstall -g azure-functions-core-tools`.
      return [
        {
          name: 'Azure Functions Core Tools (npm global)',
          source: 'npm registry',
          command: 'npm',
          args: [
            'install',
            '-g',
            'azure-functions-core-tools@4',
            '--unsafe-perm',
            'true',
          ],
          description,
        },
      ];
  }
}

/**
 * Render the prereqs report as a short, human-readable summary suitable for
 * the start-up banner of `rayfin dev functions apply`.
 */
export function formatPrereqsReport(report: FunctionsPrereqsReport): string {
  const lines: string[] = [];
  lines.push(
    `  ${report.node.ok ? '✅' : '❌'} Node.js ${report.node.version ?? 'not found'}` +
      (report.node.minimumMajor && !report.node.ok
        ? ` (require ≥ ${report.node.minimumMajor})`
        : '')
  );
  lines.push(
    `  ${report.funcCoreTools.ok ? '✅' : '❌'} Azure Functions Core Tools ${
      report.funcCoreTools.version ?? 'not found'
    }`
  );
  return lines.join('\n');
}

/**
 * Format an {@link InstallStep} as a single shell-style command line for the
 * consent prompt. Use this only for display — actual execution goes through
 * {@link runInstallStep}, which never invokes a shell.
 */
export function formatStepCommand(step: InstallStep): string {
  return `${step.command} ${step.args.join(' ')}`;
}

/**
 * Synchronously run one install step. Uses {@link spawnSyncSafe} so
 * Windows can resolve `.cmd` shims (`choco.cmd`, `brew.cmd` via WSL,
 * etc.) via PATHEXT without us tripping Node.js v22+'s DEP0190
 * deprecation warning that fires when `shell: true` is combined with
 * a separately-supplied `args` array. Stdio is inherited so the
 * underlying installer's own progress UI is visible.
 *
 * Returns `true` when the step exits zero.
 */
function runInstallStep(step: InstallStep): boolean {
  const result = spawnSyncSafe(step.command, [...step.args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  return result.status === 0;
}

/**
 * Refresh the current process's `PATH` from the persistent Windows
 * environment. Winget / MSI installers (and many Homebrew formulas) extend
 * PATH in HKCU/HKLM but the running shell's `process.env.PATH` is captured
 * at startup, so a freshly installed binary is invisible until the user
 * opens a new shell — unless we re-read the registry-backed value and
 * splice it in here.
 *
 * No-op on non-Windows; macOS / Linux installers typically don't mutate
 * the parent shell's PATH at all.
 */
export function refreshPathFromOs(): void {
  if (process.platform !== 'win32') return;
  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")',
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false,
      }
    );
    if (result.status !== 0) return;
    const persisted = String(result.stdout ?? '').trim();
    if (!persisted) return;
    // Merge persisted PATH with whatever the current process already has so
    // we don't drop any in-process additions (e.g. test stubs).
    const current = process.env.PATH ?? '';
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const part of [...current.split(';'), ...persisted.split(';')]) {
      const normalised = part.replace(/[\\/]+$/, '');
      if (!normalised) continue;
      const key = normalised.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(part);
    }
    process.env.PATH = merged.join(';');
  } catch {
    // Best-effort — if PATH refresh fails, the caller will still surface
    // the "open a new shell" hint and exit cleanly.
  }
}

/**
 * Walk the install plan, prompting **each step individually** for explicit
 * consent. Non-interactive sessions (no TTY) print the install commands and
 * return `false`. Returns `true` when every step the user approved completed
 * successfully and the resulting plan reports all prerequisites as `ok`.
 *
 * Note: there is no `--yes` / batch-consent flag — every install requires
 * an explicit y/N from the user.
 */
export async function promptAndInstall(
  plan: InstallStep[],
  options: { isInteractive?: boolean; logger?: (msg: string) => void } = {}
): Promise<boolean> {
  const log = options.logger ?? console.log;
  if (plan.length === 0) return true;

  if (options.isInteractive === false || !isInteractive({})) {
    log(
      '❌ Missing prerequisites and no interactive terminal available. ' +
        'Run the following commands yourself and retry:'
    );
    for (const step of plan) {
      log(`   • ${step.name}: ${formatStepCommand(step)}`);
    }
    return false;
  }

  for (const step of plan) {
    log('');
    log(`Missing: ${step.name}`);
    log(`Source : ${step.source}`);
    log(`Command: ${formatStepCommand(step)}`);
    log(step.description);
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Proceed with this install?`,
        default: false,
      },
    ]);
    if (!confirm) {
      log(`❌ Skipped install of ${step.name}. Aborting.`);
      return false;
    }
    log(`▶  Installing ${step.name}...`);
    const ok = runInstallStep(step);
    // The installer typically extends the user's persistent PATH; re-read
    // it so subsequent prereq checks (in this same process) can find the
    // freshly installed binary without forcing a shell restart.
    refreshPathFromOs();
    if (!ok) {
      // Some installers (notably `winget install` when the package is
      // already present) exit non-zero with "No available upgrade found"
      // — semantically a success because the desired end-state is met.
      // Re-inspect prereqs; if everything is now ok, treat as success and
      // move on. If still missing, the failure is real.
      const recheck = inspectFunctionsPrereqs();
      if (recheck.funcCoreTools.ok) {
        log(
          `✅ ${step.name} already installed (installer reported non-zero, prereq is satisfied).`
        );
        continue;
      }
      log(`❌ ${step.name} install failed. Aborting.`);
      return false;
    }
    log(`✅ ${step.name} installed.`);
  }

  return true;
}
