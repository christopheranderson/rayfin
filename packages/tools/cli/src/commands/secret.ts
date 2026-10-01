import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { Command } from 'commander';
import inquirer from 'inquirer';

import { getAuthenticatedToken } from '../auth/index.js';
import { CliHandledError } from '../errors.js';
import {
  getSecretsFromRemoteEndpoint,
  applySecretsToRemoteEndpoint,
  deleteSecretFromRemoteEndpoint,
} from '../services/fabric/rayfin-item.js';
import {
  removeSecretMetadata,
  upsertSecretMetadata,
} from '../utils/config-utils.js';
import {
  emitJson,
  emitJsonError,
  isInteractive,
  modeError,
  modeLog,
  resolveOutputMode,
  resolveRootOutputFlags,
} from '../utils/output-mode.js';
import {
  getRemoteEndpoint,
  hasRemoteEndpoint,
} from '../utils/remote-endpoint-utils.js';
import { HttpError } from '../utils/retry-utils.js';
import { generateSecretsTypes } from '../utils/secrets-types-generator.js';

/**
 * Formats a date string for display.
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleString();
  } catch {
    return dateString;
  }
}

async function readSecretValueFromStdin(): Promise<string> {
  const chunks: string[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }

  const value = chunks.join('').replace(/[\r\n]+$/, '');
  if (!value.trim()) {
    throw new Error('No secret value was provided on stdin.');
  }

  return value;
}

function parseSecretsFromEnvFile(envContent: string): Array<{
  name: string;
  value: string;
}> {
  const secrets: Array<{ name: string; value: string }> = [];

  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const name = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();

    const unquotedValue =
      value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value.startsWith("'") && value.endsWith("'")
          ? value.slice(1, -1)
          : value;

    if (!name) {
      continue;
    }

    secrets.push({ name, value: unquotedValue });
  }

  return secrets;
}

/**
 * Root-level 'secret' command for managing secrets on the deployed Rayfin item.
 * Includes 'set' and 'list' subcommands.
 */
export const secretCommand = new Command('secret')
  .description('Manage secrets for deployed Rayfin items')
  .addCommand(
    new Command('set')
      .argument('[name]', 'The name of the secret to set')
      .option(
        '--describe [description]',
        'Description for this secret in rayfin/rayfin.yml; must use = syntax: --describe="My description"'
      )
      .option('--stdin', 'Read secret value from stdin instead of prompting')
      .option('--env-file <path>', 'Set multiple secrets from a dotenv file')
      .description('Set one secret or bulk apply secrets from a dotenv file')
      .action(async function (this: Command, name?: string) {
        const rootFlags = resolveRootOutputFlags(this);
        const jsonFlag = rootFlags.json ?? false;
        const verbose = rootFlags.verbose;
        const mode = resolveOutputMode({ json: jsonFlag });
        const verboseLog = (...args: any[]) => {
          if (verbose) {
            modeLog(mode, ...args);
          }
        };
        const options = this.optsWithGlobals() as {
          stdin?: boolean;
          envFile?: string;
        };
        const describeOption = this.optsWithGlobals().describe as
          | string
          | boolean
          | undefined;
        const description =
          typeof describeOption === 'string' ? describeOption : undefined;

        try {
          // Enforce --describe=<value> syntax. A bare '--describe' token in argv
          // means the user wrote either '--describe "value"' (space-separated,
          // which is ambiguous) or '--describe' with no value at all.
          if (process.argv.some((arg) => arg === '--describe')) {
            modeError(
              mode,
              '❌ --describe requires the = syntax: --describe="My description"'
            );
            modeError(
              mode,
              '   Use \'--describe="My description"\' instead of \'--describe "My description"\'.'
            );
            throw new CliHandledError(
              new Error('--describe requires the = syntax')
            );
          }

          verboseLog('Setting secret...');

          if (options.stdin && options.envFile) {
            modeError(
              mode,
              '❌ --stdin and --env-file cannot be used together'
            );
            modeError(
              mode,
              '   Use either --stdin for one secret or --env-file for bulk set.'
            );
            throw new CliHandledError(
              new Error('--stdin and --env-file cannot be used together')
            );
          }

          if (options.envFile && name) {
            modeError(mode, '❌ Do not pass <name> with --env-file');
            modeError(
              mode,
              "   Use 'rayfin secret set --env-file <path>' for bulk updates."
            );
            throw new CliHandledError(
              new Error('<name> cannot be combined with --env-file')
            );
          }

          if (options.stdin && !name) {
            modeError(mode, '❌ Secret name is required when using --stdin');
            modeError(mode, "   Use 'rayfin secret set <NAME> --stdin'.");
            throw new CliHandledError(
              new Error('Secret name is required when using --stdin')
            );
          }

          if (!options.envFile && !name) {
            modeError(mode, '❌ Secret name is required');
            modeError(
              mode,
              "   Use 'rayfin secret set <NAME>' or 'rayfin secret set --env-file <path>'."
            );
            throw new CliHandledError(new Error('Secret name is required'));
          }

          // ── Validate remote endpoint ──────────────────────────────
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
            throw new CliHandledError(
              new Error('No remote endpoint configured')
            );
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
            throw new CliHandledError(
              new Error(
                'Could not construct secrets endpoint from deployment registry'
              )
            );
          }

          verboseLog('Item endpoint:', itemEndpoint);

          if (options.envFile) {
            const envFilePath = resolve(process.cwd(), options.envFile);

            if (!existsSync(envFilePath)) {
              modeError(mode, `❌ Env file not found: ${envFilePath}`);
              modeError(mode, '   Check the path and re-run the command.');
              throw new CliHandledError(new Error('Env file not found'));
            }

            const envContent = readFileSync(envFilePath, 'utf-8');
            const secrets = parseSecretsFromEnvFile(envContent);

            if (secrets.length === 0) {
              modeError(
                mode,
                `❌ No KEY=VALUE entries found in ${envFilePath}`
              );
              modeError(
                mode,
                '   Add at least one KEY=VALUE pair and try again.'
              );
              throw new CliHandledError(
                new Error('No KEY=VALUE entries found in env file')
              );
            }

            const responses = await applySecretsToRemoteEndpoint({
              itemEndpoint,
              secrets,
              getAuthorizationHeader: async () => {
                const authResult = await getAuthenticatedToken();
                verboseLog('Auth header acquired');
                return `Bearer ${authResult.token}`;
              },
              log: verboseLog,
            });

            modeLog(
              mode,
              `✅ Secrets applied (${responses.length}/${secrets.length} uploaded)`
            );

            if (mode === 'json') {
              emitJson({
                status: 'success',
                count: responses.length,
                secrets: responses.map((s) => ({
                  name: s.name,
                  createdAt: s.createdAt,
                  updatedAt: s.updatedAt,
                })),
              });
            }

            return;
          }

          // ── Resolve single secret value ─────────────────────────────
          let secretValue: string;

          if (options.stdin) {
            secretValue = await readSecretValueFromStdin();
          } else if (process.stdin.isTTY && process.env.CI !== 'true') {
            const answer = await inquirer.prompt<{ secretValue: string }>([
              {
                type: 'password',
                name: 'secretValue',
                message: `Enter secret value for "${name}"`,
                mask: '*',
              },
            ]);
            secretValue = answer.secretValue;
          } else {
            modeError(mode, '❌ Secret set requires interactive input');
            modeError(
              mode,
              "   Use 'rayfin secret set <NAME> --stdin' for non-interactive usage."
            );
            throw new CliHandledError(
              new Error('Secret set requires interactive input')
            );
          }

          const secretName = name!;

          // ── Send single secret to endpoint ─────────────────────────
          const responses = await applySecretsToRemoteEndpoint({
            itemEndpoint,
            secrets: [{ name: secretName, value: secretValue }],
            getAuthorizationHeader: async () => {
              const authResult = await getAuthenticatedToken();
              verboseLog('Auth header acquired');
              return `Bearer ${authResult.token}`;
            },
            log: verboseLog,
          });

          if (responses.length === 0) {
            modeError(mode, `❌ Failed to set secret "${secretName}"`);
            modeError(mode, '   Verify the secret name and try again.');
            throw new CliHandledError(
              new Error('Endpoint returned no result for the secret')
            );
          }

          const response = responses[0];

          const metadataResult = upsertSecretMetadata(
            secretName,
            process.cwd(),
            description
          );
          if (metadataResult.status === 'added') {
            modeLog(
              mode,
              `📝 Added secret metadata for "${secretName}" to rayfin/rayfin.yml`
            );
          }

          // Keep the generated secrets type in step with rayfin.yml so
          // functions can reference the new secret without hard-coding its name.
          const typesResult = generateSecretsTypes(process.cwd());
          if (typesResult.status === 'written') {
            modeLog(
              mode,
              `🧬 Updated secret types in rayfin/functions/src/secrets.generated.ts`
            );
          }

          modeLog(
            mode,
            `✅ Secret "${secretName}" set successfully (updated: ${formatDate(response.updatedAt)})`
          );

          if (mode === 'json') {
            emitJson({
              status: 'success',
              name: response.name,
              createdAt: response.createdAt,
              updatedAt: response.updatedAt,
            });
          }
        } catch (error: any) {
          if (error instanceof CliHandledError) {
            throw error;
          }
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          modeError(mode, `❌ Failed to set secret: ${errorMessage}`);
          if (mode === 'json') {
            emitJsonError(mode, errorMessage);
          }
          throw new CliHandledError(error);
        }
      })
  )
  .addCommand(
    new Command('list')
      .description('List all secrets (names and timestamps only, no values)')
      .action(async function (this: Command) {
        const rootFlags = resolveRootOutputFlags(this);
        const jsonFlag = rootFlags.json ?? false;
        const verbose = rootFlags.verbose;
        const mode = resolveOutputMode({ json: jsonFlag });
        const verboseLog = (...args: any[]) => {
          if (verbose) {
            modeLog(mode, ...args);
          }
        };

        try {
          verboseLog('Retrieving secrets...');

          // ── Validate remote endpoint ──────────────────────────────
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
            throw new CliHandledError(
              new Error('No remote endpoint configured')
            );
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
            throw new CliHandledError(
              new Error(
                'Could not construct secrets endpoint from deployment registry'
              )
            );
          }

          verboseLog('Item endpoint:', itemEndpoint);

          // ── Retrieve secrets ──────────────────────────────────────
          const secrets = await getSecretsFromRemoteEndpoint({
            itemEndpoint,
            getAuthorizationHeader: async () => {
              const authResult = await getAuthenticatedToken();
              verboseLog('Auth header acquired');
              return `Bearer ${authResult.token}`;
            },
            log: verboseLog,
          });

          // ── Display secrets ───────────────────────────────────────
          if (mode === 'json') {
            emitJson({
              status: 'success',
              count: secrets.length,
              secrets: secrets.map((s) => ({
                name: s.name,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
              })),
            });
          } else if (process.stdin.isTTY) {
            if (secrets.length === 0) {
              modeLog(mode, '📭 No secrets found');
            } else {
              modeLog(mode, `📋 Secrets (${secrets.length}):`);
              modeLog(mode, '');

              for (const secret of secrets) {
                modeLog(mode, `  Name:         ${secret.name}`);
                modeLog(
                  mode,
                  `  Created:      ${formatDate(secret.createdAt)}`
                );
                modeLog(
                  mode,
                  `  Last Updated: ${formatDate(secret.updatedAt)}`
                );
                modeLog(mode, '');
              }
            }
          }
        } catch (error: any) {
          if (error instanceof CliHandledError) {
            throw error;
          }
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          modeError(mode, `❌ Failed to retrieve secrets: ${errorMessage}`);
          if (mode === 'json') {
            emitJsonError(mode, errorMessage);
          }
          throw new CliHandledError(error);
        }
      })
  )
  .addCommand(
    new Command('delete')
      .argument('<name>', 'The name of the secret to delete')
      .option('-y, --yes', 'Skip the confirmation prompt', false)
      .description('Delete a secret from the deployed Rayfin item')
      .action(async function (this: Command, name: string) {
        const rootFlags = resolveRootOutputFlags(this);
        const jsonFlag = rootFlags.json ?? false;
        const verbose = rootFlags.verbose;
        const mode = resolveOutputMode({ json: jsonFlag });
        const verboseLog = (...args: any[]) => {
          if (verbose) {
            modeLog(mode, ...args);
          }
        };
        const options = this.optsWithGlobals() as { yes?: boolean };

        try {
          verboseLog('Deleting secret...');

          // ── Validate remote endpoint ──────────────────────────────
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
            throw new CliHandledError(
              new Error('No remote endpoint configured')
            );
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
            throw new CliHandledError(
              new Error(
                'Could not construct secrets endpoint from deployment registry'
              )
            );
          }

          verboseLog('Item endpoint:', itemEndpoint);

          // ── Confirm deletion ───────────────────────────────────────
          if (!options.yes && isInteractive()) {
            const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: 'confirm',
                name: 'confirm',
                message: `Delete secret "${name}"? This cannot be undone.`,
                default: false,
              },
            ]);

            if (!confirm) {
              modeLog(mode, 'Cancelled.');
              if (mode === 'json') {
                emitJson({ status: 'cancelled', name });
              }
              return;
            }
          }

          // ── Delete secret ──────────────────────────────────────────
          await deleteSecretFromRemoteEndpoint({
            itemEndpoint,
            name,
            getAuthorizationHeader: async () => {
              const authResult = await getAuthenticatedToken();
              verboseLog('Auth header acquired');
              return `Bearer ${authResult.token}`;
            },
            log: verboseLog,
          });

          modeLog(mode, `✅ Secret "${name}" deleted successfully`);

          // Drop the entry from rayfin.yml and regenerate, so the secret stops
          // appearing in the type as soon as it stops existing.
          const metadataResult = removeSecretMetadata(name, process.cwd());
          if (metadataResult.status === 'removed') {
            modeLog(
              mode,
              `📝 Removed secret metadata for "${name}" from rayfin/rayfin.yml`
            );
          }
          const typesResult = generateSecretsTypes(process.cwd());
          if (typesResult.status === 'written') {
            modeLog(
              mode,
              `🧬 Updated secret types in rayfin/functions/src/secrets.generated.ts`
            );
          }

          if (mode === 'json') {
            emitJson({ status: 'success', name });
          }
        } catch (error: any) {
          if (error instanceof CliHandledError) {
            throw error;
          }
          if (error instanceof HttpError && error.statusCode === 404) {
            const message = `Secret "${name}" was not found. It may already be deleted, or secret management may not be enabled for this item.`;
            modeError(mode, `❌ ${message}`);
            modeError(
              mode,
              "   Run 'rayfin secret list' to see existing secrets."
            );
            if (mode === 'json') {
              emitJsonError(mode, message);
            }
            throw new CliHandledError(error);
          }

          const errorMessage =
            error instanceof Error ? error.message : String(error);
          modeError(mode, `❌ Failed to delete secret: ${errorMessage}`);
          if (mode === 'json') {
            emitJsonError(mode, errorMessage);
          }
          throw new CliHandledError(error);
        }
      })
  );

export default secretCommand;
