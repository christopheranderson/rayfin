import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { RayfinClient } from '@microsoft/rayfin-client';

import type { TodoAppSchema } from '../../../rayfin/data/schema';
import type { TodoAppStorageSchema } from '../../../rayfin/storage/schema';
import { startBackend, stopBackend } from '../../shared/backend';
import { createTestClient } from '../../shared/client-factory';
import { generateUniqueUser } from '../../shared/test-data';

export interface QueryBuilderTestContext {
  client: RayfinClient<TodoAppSchema, TodoAppStorageSchema>;
  userId: string;
  cleanup: () => Promise<void>;
}

export async function createQueryBuilderTestContext(): Promise<QueryBuilderTestContext> {
  await startBackend();

  const client = createTestClient();
  const user = generateUniqueUser();

  await client.auth.signUp({ email: user.email, password: user.password });
  await client.auth.signIn({ email: user.email, password: user.password });

  const session = client.auth.getSession();
  if (!session.user) {
    throw new Error('Failed to authenticate test user');
  }

  // A backend restart can report healthy before its data plane accepts the
  // first GraphQL request. Warm it with an idempotent read so a mutation is
  // never used as the readiness probe (and then ambiguously times out).
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.data.Todo.select(['id']).execute();
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      }
    }
  }
  if (lastError !== undefined) throw lastError;

  return {
    client,
    userId: session.user.id,
    cleanup: async () => {
      await stopBackend();
    },
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getDialect(): string {
  // Extract dialect from rayfin.yml with regex
  try {
    const configPath = resolve(__dirname, '../../../rayfin/rayfin.yml');
    const content = readFileSync(configPath, 'utf-8');

    // Match "dialect: value" or "dialect: ${VAR:-default}"
    const match = content.match(/^\s*dialect:\s*(.+)$/m);
    if (!match) return 'mssql';

    const value = match[1].trim();

    // Handle ${VAR:-default} syntax - extract default value
    const envMatch = value.match(/\$\{[^:]+:-([^}]+)\}/);
    if (envMatch) {
      // Prefer explicit env var (set when running tests)
      if (process.env.DATA_DIALECT) {
        return process.env.DATA_DIALECT;
      }
      // return default from config
      return envMatch[1];
    }

    return value;
  } catch {
    return 'mssql';
  }
}
