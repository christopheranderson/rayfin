/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  deepMerge,
  parseRayfinYaml,
  parseRayfinYamlInterpolated,
  type RayfinConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import * as vscode from 'vscode';
import { stringify } from 'yaml';

import { ext } from '../../extensionVariables';
import { fileExists, readTextFile, writeTextFile } from '../../utils/fs';

import { findRayfinProjectRoot } from './projectUtils';

// ── Environment Variable Loading ───────────────────────────────────────

// ── Inline .env parser (works in both desktop and web) ─────────────────

/**
 * Parses a `.env` file content string into key-value pairs.
 * Supports `KEY=VALUE`, comments (`#`), and quoted values.
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Options for loading environment variables from .env files and shell.
 */
export interface EnvLoadOptions {
  /** URI of the project root (where rayfin/ folder is located) */
  projectRoot: vscode.Uri;
  /** Optional relative path to .env file within the project */
  envFilePath?: string;
}

/**
 * Loads environment variables from .env file and merges with shell environment.
 * Priority: shell environment \> .env file
 */
export async function loadEnvironmentVariables(
  options: EnvLoadOptions
): Promise<Map<string, string>> {
  const { projectRoot, envFilePath } = options;
  const envVars = new Map<string, string>();

  // Resolve .env file URI
  const envFileUri = envFilePath
    ? vscode.Uri.joinPath(projectRoot, envFilePath)
    : vscode.Uri.joinPath(projectRoot, 'rayfin', '.env');

  // Load .env file if it exists
  if (await fileExists(envFileUri)) {
    try {
      const envFileContent = await readTextFile(envFileUri);
      const parsed = parseDotenv(envFileContent);
      for (const [key, value] of Object.entries(parsed)) {
        envVars.set(key, value);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load .env file at ${envFileUri.toString(true)}: ${message}`
      );
    }
  }

  // Merge shell environment (shell wins over .env) — only available on desktop
  const processLike = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  const processEnv = processLike?.env;
  if (processEnv) {
    for (const [key, value] of Object.entries(processEnv)) {
      if (value !== undefined) {
        envVars.set(key, value);
      }
    }
  }

  return envVars;
}

// ── Config Loading/Updating ────────────────────────────────────────────

/**
 * Loads the Rayfin configuration from `rayfin/rayfin.yml` with environment
 * variable interpolation.
 *
 * Works in both desktop and web extension hosts.
 *
 * @param startUri - The URI to start searching from (e.g. workspace folder URI).
 * @param options - Options for loading the config.
 * @returns The Rayfin configuration object, or null if not found.
 */
export async function loadRayfinConfig(
  startUri: vscode.Uri,
  options: { envFile?: string; interpolate?: boolean } = {}
): Promise<RayfinConfig | null> {
  const { envFile, interpolate = true } = options;

  let projectRoot: vscode.Uri;
  try {
    projectRoot = await findRayfinProjectRoot(startUri);
  } catch {
    return null;
  }

  const rayfinConfigUri = vscode.Uri.joinPath(
    projectRoot,
    'rayfin',
    'rayfin.yml'
  );

  if (!(await fileExists(rayfinConfigUri))) {
    return null;
  }

  const configContent = await readTextFile(rayfinConfigUri);

  if (!interpolate) {
    return parseRayfinYaml(configContent);
  }

  // Load environment variables only when interpolation is requested
  const envVars = await loadEnvironmentVariables({
    projectRoot,
    envFilePath: envFile,
  });

  // Compute display path for error messages
  const envFileDisplayPath = envFile ?? 'rayfin/.env';

  return parseRayfinYamlInterpolated(
    configContent,
    envVars,
    envFileDisplayPath
  );
}

/**
 * Updates the Rayfin configuration in `rayfin/rayfin.yml`.
 *
 * Works in both desktop and web extension hosts.
 *
 * @param updates - The properties to update in the configuration.
 * @param startUri - The URI to start searching from.
 * @returns boolean indicating whether the update was successful.
 */
export async function updateRayfinConfig(
  updates: Partial<RayfinConfig> & Record<string, unknown>,
  startUri: vscode.Uri
): Promise<boolean> {
  try {
    // Read the raw config (without interpolation) so ${VAR} references
    // are preserved when writing back to disk.
    const existingConfig = await loadRayfinConfig(startUri, {
      interpolate: false,
    });

    if (!existingConfig) {
      ext.outputChannel.appendLine(
        'Could not update rayfin.yml: Configuration file not found'
      );
      return false;
    }

    const projectRoot = await findRayfinProjectRoot(startUri);
    const rayfinConfigUri = vscode.Uri.joinPath(
      projectRoot,
      'rayfin',
      'rayfin.yml'
    );

    const updatedConfig = deepMerge(existingConfig, updates) as RayfinConfig;

    const yamlContent: string = stringify(updatedConfig, {
      lineWidth: 0,
      doubleQuotedAsJSON: false,
    });

    await writeTextFile(rayfinConfigUri, yamlContent);

    ext.outputChannel.appendLine('Updated rayfin.yml configuration');
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ext.outputChannel.appendLine(
      `Failed to update rayfin.yml: ${errorMessage}`
    );
    return false;
  }
}
