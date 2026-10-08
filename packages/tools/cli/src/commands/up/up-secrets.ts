import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { Command } from 'commander';

import { getAuthenticatedToken } from '../../auth/index.js';
import {
  applySecretsToRemoteEndpoint,
  type SecretWriteRequest,
  type SecretWriteResponse,
} from '../../services/fabric/rayfin-item.js';
import {
  emitJson,
  emitJsonError,
  modeError,
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../../utils/output-mode.js';
import { findRayfinProjectRoot } from '../../utils/project-utils.js';
import {
  getRemoteEndpoint,
  hasRemoteEndpoint,
} from '../../utils/remote-endpoint-utils.js';
export type { SecretWriteRequest, SecretWriteResponse };

export interface SecretsApplyResult {
  status: 'applied' | 'skipped';
  envFilePath: string;
  secretsCount: number;
  uploadedCount: number;
  reason?: 'missing-file' | 'no-secrets';
}

interface ApplySecretsFromEnvFileOptions {
  itemEndpoint: string;
  projectRoot: string;
  envFilePath?: string;
  mode: ReturnType<typeof resolveOutputMode>;
  log: (...args: any[]) => void;
  getAuthorizationHeader: () => Promise<string>;
}

/**
 * Parse secrets from .env.secrets content.
 * Every KEY=VALUE entry is treated as a secret.
 */
function parseSecretsFromEnv(envContent: string): SecretWriteRequest[] {
  const secrets: SecretWriteRequest[] = [];

  // Parse KEY=VALUE format line by line
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse KEY=VALUE
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();

    // Remove quotes if present
    const unquotedValue =
      value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value.startsWith("'") && value.endsWith("'")
          ? value.slice(1, -1)
          : value;

    secrets.push({
      name: key,
      value: unquotedValue,
    });
  }

  return secrets;
}

export async function applySecretsFromEnvFile({
  itemEndpoint,
  projectRoot,
  envFilePath,
  mode,
  log,
  getAuthorizationHeader,
}: ApplySecretsFromEnvFileOptions): Promise<SecretsApplyResult> {
  const resolvedEnvFilePath =
    envFilePath ?? join(projectRoot, 'rayfin', '.env.secrets');
  log('Resolved secrets file path:', resolvedEnvFilePath);

  if (!existsSync(resolvedEnvFilePath)) {
    const message = `Secrets file not found at ${resolvedEnvFilePath}. Skipping secrets apply.`;
    modeLog(mode, `⚠️  ${message}`);
    return {
      status: 'skipped',
      envFilePath: resolvedEnvFilePath,
      secretsCount: 0,
      uploadedCount: 0,
      reason: 'missing-file',
    };
  }

  const envContent = readFileSync(resolvedEnvFilePath, 'utf-8');
  log(`Read secrets file: ${resolvedEnvFilePath} (${envContent.length} bytes)`);

  const secrets = parseSecretsFromEnv(envContent);
  log(`Parsed ${secrets.length} secret entries from secrets file`);

  if (secrets.length === 0) {
    modeLog(
      mode,
      `⚠️  No KEY=VALUE entries found in ${resolvedEnvFilePath}. Skipping secrets apply.`
    );
    return {
      status: 'skipped',
      envFilePath: resolvedEnvFilePath,
      secretsCount: 0,
      uploadedCount: 0,
      reason: 'no-secrets',
    };
  }

  for (const secret of secrets) {
    log(`  - ${secret.name}`);
  }

  const writeResponses = await applySecretsToRemoteEndpoint({
    itemEndpoint,
    secrets,
    getAuthorizationHeader,
    log,
  });

  modeLog(
    mode,
    `✅ Secrets applied (${writeResponses.length}/${secrets.length} uploaded)`
  );

  return {
    status: 'applied',
    envFilePath: resolvedEnvFilePath,
    secretsCount: secrets.length,
    uploadedCount: writeResponses.length,
  };
}

/**
 * Secrets subcommand for remote deployment.
 * Reads key/value pairs from .env.secrets, sends to BaaS workload,
 * and validates persistence per the secret management PoC spec.
 */
export const upSecretsCommand = new Command('secrets')
  .description('Manage secrets for remote Rayfin item deployment')
  .addCommand(
    new Command('apply')
      .description(
        'Read secrets from .env.secrets and apply to remote Rayfin item workload endpoint'
      )
      .option(
        '--env-file <path>',
        'Path to secrets file (defaults to rayfin/.env.secrets)'
      )
      .option('--json', 'Output result as JSON', false)
      .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
      .option(
        '--encryption-fallback-enabled',
        'Allow plaintext token storage when OS keychain is unavailable',
        false
      )
      .action(async function (
        this: Command,
        options: {
          envFile?: string;
          json?: boolean;
          yes?: boolean;
          encryptionFallbackEnabled?: boolean;
        }
      ) {
        const rootFlags = resolveRootOutputFlags(this);
        const jsonFlag = options.json ?? rootFlags.json ?? false;
        const verbose = rootFlags.verbose;
        const mode = resolveOutputMode({ json: jsonFlag });
        const verboseLog = (...args: any[]) => {
          if (verbose) {
            modeLog(mode, ...args);
          }
        };

        try {
          verboseLog('Starting secrets apply...');

          // ── Resolve remote endpoint ──────────────────────────────
          verboseLog('Resolving remote endpoint...');

          if (!hasRemoteEndpoint()) {
            if (mode === 'json') {
              emitJsonError(
                mode,
                'No remote endpoint configured. Run "rayfin up" first.'
              );
            }
            modeError(mode, '❌ No remote endpoint configured');
            modeError(
              mode,
              "   Run 'rayfin up' first to deploy your item to Fabric."
            );
            process.exit(1);
          }

          const itemEndpoint = getRemoteEndpoint();
          if (!itemEndpoint) {
            if (mode === 'json') {
              emitJsonError(
                mode,
                'Could not construct secrets endpoint from deployment registry.'
              );
            }
            modeError(
              mode,
              '❌ Could not construct secrets endpoint from deployment registry.'
            );
            process.exit(1);
          }

          const projectRoot = findRayfinProjectRoot(process.cwd(), {
            verbose: false,
            silent: true,
          });

          verboseLog('Item endpoint:', itemEndpoint);

          const result = await applySecretsFromEnvFile({
            itemEndpoint,
            projectRoot,
            envFilePath: options.envFile,
            mode,
            log: verboseLog,
            getAuthorizationHeader: async () => {
              const authResult = await getAuthenticatedToken(undefined, {
                encryptionFallbackEnabled:
                  options.encryptionFallbackEnabled ?? false,
              });
              verboseLog('Auth header acquired');
              return `Bearer ${authResult.token}`;
            },
          });

          if (mode === 'json') {
            emitJson({
              status: result.status === 'applied' ? 'success' : 'skipped',
              applyStatus: result.status,
              envFilePath: result.envFilePath,
              secretsCount: result.secretsCount,
              uploadedCount: result.uploadedCount,
              ...(result.reason ? { reason: result.reason } : {}),
            });
          }
        } catch (error: any) {
          if (mode === 'json') {
            emitJsonError(
              mode,
              error.message || 'Unknown error during secrets apply'
            );
          }
          modeError(
            mode,
            `❌ Error: ${error.message || 'Unknown error during secrets apply'}`
          );
          process.exit(1);
        }
      })
  );
