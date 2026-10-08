import { randomUUID } from 'crypto';
import { mkdir, rm, readFile, access, constants } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createEnvFile,
  envBackupNoticeLines,
  readEnvFile,
  upsertEnvVariables,
  updateEnvVariables,
  envFileExists,
  EnvVariable,
} from '../env-file-utils';

describe('env-file-utils', () => {
  let testDir: string;
  let rayfinDir: string;
  let envFilePath: string;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    rayfinDir = join(testDir, 'rayfin');
    envFilePath = join(rayfinDir, '.env');

    await mkdir(rayfinDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  it('formats the environment backup notice', () => {
    expect(
      envBackupNoticeLines({
        sourcePath: '/proj/rayfin/.env',
        backupPath: '/proj/rayfin/.env.bak',
      })
    ).toEqual([
      'ℹ️  Backed up your previous /proj/rayfin/.env to /proj/rayfin/.env.bak before rewriting in env-strategy v2 format.',
      '   Variable values are preserved; comments and ordering are not. Diff the two files to recover any custom content.',
    ]);
  });

  describe('createEnvFile', () => {
    it('should create .env file with valid variables', async () => {
      const variables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
        { key: 'Data__Enabled', value: 'false' },
        { key: 'Storage__Enabled', value: 'true' },
      ];

      await createEnvFile(rayfinDir, variables);

      expect(await fileExists(envFilePath)).toBe(true);

      const content = await readFile(envFilePath, 'utf8');
      expect(content).toContain('# Rayfin environment configuration');
      expect(content).toContain('Auth__Enabled=true');
      expect(content).toContain('Data__Enabled=false');
      expect(content).toContain('Storage__Enabled=true');
    });

    it('should overwrite existing .env file', async () => {
      const initialVariables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
      ];

      const updatedVariables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'false' },
        { key: 'Data__Enabled', value: 'true' },
      ];

      await createEnvFile(rayfinDir, initialVariables);
      await createEnvFile(rayfinDir, updatedVariables);

      const content = await readFile(envFilePath, 'utf8');
      expect(content).toContain('Auth__Enabled=false');
      expect(content).toContain('Data__Enabled=true');
    });

    it('should preserve insertion order of environment variables', async () => {
      const variables: EnvVariable[] = [
        { key: 'Storage__Enabled', value: 'true' },
        { key: 'Auth__Enabled', value: 'true' },
        { key: 'Data__Enabled', value: 'false' },
      ];

      await createEnvFile(rayfinDir, variables);

      const content = await readFile(envFilePath, 'utf8');
      const lines = content.split('\n');

      // Find the lines with environment variables (skip header)
      const varLines = lines.filter(
        (line) => line && !line.startsWith('#') && line.includes('=')
      );

      expect(varLines[0]).toBe('Storage__Enabled=true');
      expect(varLines[1]).toBe('Auth__Enabled=true');
      expect(varLines[2]).toBe('Data__Enabled=false');
    });

    it('should throw error for invalid key format', async () => {
      const invalidVariables: EnvVariable[] = [
        { key: 'invalid-key', value: 'true' },
      ];

      await expect(createEnvFile(rayfinDir, invalidVariables)).rejects.toThrow(
        /Invalid environment variable key/
      );
    });

    it('should throw error for key starting with digit', async () => {
      const invalidVariables: EnvVariable[] = [{ key: '1BAD', value: 'true' }];

      await expect(createEnvFile(rayfinDir, invalidVariables)).rejects.toThrow(
        'Invalid environment variable key'
      );
    });

    it('should allow double underscores in keys', async () => {
      const variables: EnvVariable[] = [
        {
          key: 'ConnectionStrings__DefaultConnection',
          value: 'server=localhost',
        },
      ];

      await createEnvFile(rayfinDir, variables);

      const content = await readFile(envFilePath, 'utf8');
      expect(content).toContain(
        'ConnectionStrings__DefaultConnection=server=localhost'
      );
    });
  });

  describe('readEnvFile', () => {
    it('should read environment variables from .env file', async () => {
      const variables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
        { key: 'Data__Enabled', value: 'false' },
      ];

      await createEnvFile(rayfinDir, variables);

      const readVariables = await readEnvFile(rayfinDir);

      expect(readVariables).toHaveLength(2);
      expect(readVariables).toContainEqual({
        key: 'Auth__Enabled',
        value: 'true',
      });
      expect(readVariables).toContainEqual({
        key: 'Data__Enabled',
        value: 'false',
      });
    });

    it('should return empty array if file does not exist', async () => {
      const readVariables = await readEnvFile(rayfinDir);
      expect(readVariables).toEqual([]);
    });

    it('should ignore comments and empty lines', async () => {
      const content = `# Rayfin Environment Configuration
# This is a comment
Auth__Enabled=true

Data__Enabled=false
# Another comment
Storage__Enabled=true
`;

      await mkdir(rayfinDir, { recursive: true });
      // Write directly to test parsing
      const { writeFile } = await import('fs/promises');
      await writeFile(envFilePath, content, 'utf8');

      const readVariables = await readEnvFile(rayfinDir);

      expect(readVariables).toHaveLength(3);
      expect(readVariables).toContainEqual({
        key: 'Auth__Enabled',
        value: 'true',
      });
    });
  });

  describe('upsertEnvVariables', () => {
    it('should create new file if it does not exist', async () => {
      const variables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
      ];

      await upsertEnvVariables(rayfinDir, variables);

      expect(await fileExists(envFilePath)).toBe(true);

      const content = await readFile(envFilePath, 'utf8');
      expect(content).toContain('Auth__Enabled=true');
    });

    it('should update existing variables', async () => {
      const initialVariables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'false' },
        { key: 'Data__Enabled', value: 'false' },
      ];

      const updateVariables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
      ];

      await createEnvFile(rayfinDir, initialVariables);
      await upsertEnvVariables(rayfinDir, updateVariables);

      const readVariables = await readEnvFile(rayfinDir);

      expect(readVariables).toHaveLength(2);
      expect(readVariables).toContainEqual({
        key: 'Auth__Enabled',
        value: 'true',
      });
      expect(readVariables).toContainEqual({
        key: 'Data__Enabled',
        value: 'false',
      });
    });

    it('should insert new variables while preserving existing ones', async () => {
      const initialVariables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
      ];

      const newVariables: EnvVariable[] = [
        { key: 'Data__Enabled', value: 'true' },
        { key: 'Storage__Enabled', value: 'false' },
      ];

      await createEnvFile(rayfinDir, initialVariables);
      await upsertEnvVariables(rayfinDir, newVariables);

      const readVariables = await readEnvFile(rayfinDir);

      expect(readVariables).toHaveLength(3);
      expect(readVariables).toContainEqual({
        key: 'Auth__Enabled',
        value: 'true',
      });
      expect(readVariables).toContainEqual({
        key: 'Data__Enabled',
        value: 'true',
      });
      expect(readVariables).toContainEqual({
        key: 'Storage__Enabled',
        value: 'false',
      });
    });

    it('should throw error for invalid key format', async () => {
      const invalidVariables: EnvVariable[] = [
        { key: 'invalid-key', value: 'true' },
      ];

      await expect(
        upsertEnvVariables(rayfinDir, invalidVariables)
      ).rejects.toThrow('Invalid environment variable key');
    });
  });

  describe('updateEnvVariables', () => {
    it('removes managed keys while preserving unrelated values', async () => {
      await createEnvFile(rayfinDir, [
        {
          key: 'RAYFIN_PUBLIC_FUNCTIONS_URL',
          value: 'http://localhost:7071',
        },
        { key: 'USER_VALUE', value: 'keep' },
      ]);

      await updateEnvVariables(rayfinDir, [
        { key: 'RAYFIN_PUBLIC_FUNCTIONS_URL', value: null },
        { key: 'RAYFIN_PUBLIC_API_URL', value: 'https://api.example' },
      ]);

      await expect(readEnvFile(rayfinDir)).resolves.toEqual([
        { key: 'USER_VALUE', value: 'keep' },
        { key: 'RAYFIN_PUBLIC_API_URL', value: 'https://api.example' },
      ]);
    });
  });

  describe('envFileExists', () => {
    it('should return true if .env file exists', async () => {
      const variables: EnvVariable[] = [
        { key: 'Auth__Enabled', value: 'true' },
      ];

      await createEnvFile(rayfinDir, variables);

      const exists = await envFileExists(rayfinDir);
      expect(exists).toBe(true);
    });

    it('should return false if .env file does not exist', async () => {
      const exists = await envFileExists(rayfinDir);
      expect(exists).toBe(false);
    });
  });
});
