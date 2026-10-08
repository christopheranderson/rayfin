import fs from 'fs';
import path from 'path';

import { DatabaseDialect, Dialect } from '@microsoft/rayfin-core/analysis';
import { Command } from 'commander';

import { applyDbConfig } from '../../utils/apply-db-config.js';
import { applyStorageConfig } from '../../utils/apply-storage-config.js';
import {
  loadRayfinConfig,
  resolveServicePath,
} from '../../utils/config-utils.js';
import {
  modeLog,
  modeError,
  modeWarn,
  resolveOutputMode,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';

/**
 * Resolve the directory to watch for a given service.
 *
 * The watched directory has to follow `services.<service>.path` from
 * `rayfin.yml` — in a workspace layout the sources live under e.g.
 * `packages/data/rayfin/data/`, so watching a cwd-relative `./rayfin/data`
 * would silently watch nothing (or the wrong tree) and no change would ever
 * be applied. Falls back to the cwd-relative default when no project root or
 * config can be found, preserving the previous behaviour.
 */
function resolveWatchDir(type: 'db' | 'storage'): string {
  const segment = type === 'storage' ? 'storage' : 'data';
  const fallback = path.resolve(`./rayfin/${segment}`);

  let projectRoot: string;
  try {
    projectRoot = findRayfinProjectRoot(process.cwd(), {
      verbose: false,
      silent: true,
    });
  } catch {
    // Not inside a Rayfin project — preserve the previous cwd-relative
    // behaviour without comment. This is an expected, benign case.
    return fallback;
  }

  try {
    const config = loadRayfinConfig(projectRoot, { silent: true });
    const servicePath =
      type === 'storage'
        ? config?.services?.storage?.path
        : config?.services?.data?.path;
    const serviceRoot = resolveServicePath(projectRoot, servicePath);
    return path.join(serviceRoot, 'rayfin', segment);
  } catch (error) {
    // A project root exists but its config could not be read, or its service
    // path is invalid. Falling back silently would watch the wrong tree and
    // apply nothing — the exact failure this resolution exists to prevent —
    // so say so loudly before degrading.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `⚠️  Could not resolve the ${segment} service path from rayfin.yml: ${message}\n` +
        `   Falling back to ${fallback}. If this project uses a workspace ` +
        `layout, fix services.${segment}.path — otherwise changes may be ` +
        `watched in the wrong directory.`
    );
    return fallback;
  }
}

async function applyConfig(type: 'db' | 'storage', envFile?: string) {
  const mode = resolveOutputMode({ json: false });
  modeLog(mode, `Applying configuration: ${type}`);
  try {
    if (type === 'db') {
      const rayfinConfig = await loadRayfinConfig(undefined, { envFile });
      const configuredDialect = rayfinConfig?.services?.data?.dialect;

      if (!configuredDialect) {
        modeWarn(
          mode,
          '⚠️  Warning: Database dialect not configured in rayfin.yml, defaulting to mssql'
        );
      }

      const dialect = (configuredDialect || DatabaseDialect.MsSql) as Dialect;
      const projectRoot = findRayfinProjectRoot(process.cwd(), {
        verbose: false,
        silent: true,
      });
      const dataServiceRoot = resolveServicePath(
        projectRoot,
        rayfinConfig?.services?.data?.path
      );
      await applyDbConfig({
        remote: false,
        force: false,
        exitOnError: false,
        dialect,
        serviceRoot: dataServiceRoot,
        buildCommand: rayfinConfig?.services?.data?.buildCommand,
      });
    } else {
      await applyStorageConfig({
        remote: false,
        force: false,
        exitOnError: false,
      });
    }
  } catch (error) {
    modeError(
      mode,
      `Error applying config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function watchDir(dir: string, type: 'db' | 'storage', envFile?: string) {
  const mode = resolveOutputMode({ json: false });
  modeLog(mode, `Watching directory to automatically apply updates: ${dir}`);
  const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    modeLog(mode, `Detected ${eventType} in ${filename} (${dir})`);
    applyConfig(type, envFile);
  });
  // Cleanup on exit/cancel
  function cleanup() {
    try {
      watcher.close();
    } catch (e) {
      // Ignore errors on watcher close (already closed or not initialized)
    }
    // Do not call process.exit() here; let the process exit naturally
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  // Removed process.on('exit', cleanup) to prevent watcher from closing after first event
}

export const watchCommand = new Command('watch')
  .description('Watch ./rayfin/data or ./rayfin/storage and auto-apply config')
  .option(
    '--type <type>',
    'Type to watch: db (rayfin/data) or storage (rayfin/storage)',
    'db'
  )
  .action(function (this: Command, options: { type?: string }) {
    // Get parent command options (from 'rayfin dev')
    const parentOpts = this.parent?.opts() as { envFile?: string } | undefined;

    const type = options.type === 'storage' ? 'storage' : 'db';
    watchDir(resolveWatchDir(type), type, parentOpts?.envFile);
  });
