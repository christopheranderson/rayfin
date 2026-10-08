import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  interpolateString,
  interpolateConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadEnvironmentVariables } from '../env-interpolation-utils';

describe('env-interpolation-utils', () => {
  let testDir: string;
  let rayfinDir: string;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    rayfinDir = join(testDir, 'rayfin');

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

  describe('loadEnvironmentVariables', () => {
    it('should load variables from .env file', async () => {
      const envFilePath = join(rayfinDir, '.env');
      await writeFile(
        envFilePath,
        'DB_HOST=localhost\nDB_PORT=5432\nDB_NAME=test',
        'utf-8'
      );

      const envVars = loadEnvironmentVariables({
        projectRoot: testDir,
        processEnv: {},
      });

      expect(envVars.get('DB_HOST')).toBe('localhost');
      expect(envVars.get('DB_PORT')).toBe('5432');
      expect(envVars.get('DB_NAME')).toBe('test');
    });

    it('should prioritize shell environment over .env file', async () => {
      const envFilePath = join(rayfinDir, '.env');
      await writeFile(envFilePath, 'DB_HOST=localhost', 'utf-8');

      const envVars = loadEnvironmentVariables({
        projectRoot: testDir,
        processEnv: { DB_HOST: 'remote-host' },
      });

      expect(envVars.get('DB_HOST')).toBe('remote-host');
    });

    it('should use custom env file path from CLI argument', async () => {
      const customEnvPath = join(testDir, 'custom.env');
      await writeFile(customEnvPath, 'CUSTOM_VAR=custom-value', 'utf-8');

      const envVars = loadEnvironmentVariables({
        projectRoot: testDir,
        envFilePath: 'custom.env',
        processEnv: {},
      });

      expect(envVars.get('CUSTOM_VAR')).toBe('custom-value');
    });

    it('should handle missing .env file gracefully', () => {
      const envVars = loadEnvironmentVariables({
        projectRoot: testDir,
        processEnv: { SHELL_VAR: 'shell-value' },
      });

      expect(envVars.get('SHELL_VAR')).toBe('shell-value');
      expect(envVars.size).toBeGreaterThan(0);
    });
  });

  describe('interpolateString', () => {
    it('should replace simple variable reference', () => {
      const envVars = new Map([['HOST', 'localhost']]);
      const result = interpolateString('${HOST}', envVars, 'test.host');

      expect(result).toBe('localhost');
    });

    it('should replace variable with default value when variable is missing', () => {
      const envVars = new Map();
      const result = interpolateString('${PORT:-5432}', envVars, 'test.port');

      expect(result).toBe('5432');
    });

    it('should use actual value over default when variable is defined', () => {
      const envVars = new Map([['PORT', '3000']]);
      const result = interpolateString('${PORT:-5432}', envVars, 'test.port');

      expect(result).toBe('3000');
    });

    it('should use default value when variable is empty string', () => {
      const envVars = new Map([['PORT', '']]);
      const result = interpolateString('${PORT:-5432}', envVars, 'test.port');

      expect(result).toBe('5432');
    });

    it('should handle partial interpolation in strings', () => {
      const envVars = new Map([
        ['HOST', 'example.com'],
        ['PORT', '8080'],
      ]);
      const result = interpolateString(
        'http://${HOST}:${PORT}/api',
        envVars,
        'test.url'
      );

      expect(result).toBe('http://example.com:8080/api');
    });

    it('should throw error for missing variable without default', () => {
      const envVars = new Map();

      expect(() => {
        interpolateString('${MISSING_VAR}', envVars, 'test.field');
      }).toThrow(/MISSING_VAR.*not defined/);
    });
  });

  describe('interpolateConfig', () => {
    it('should interpolate strings in nested objects', () => {
      const envVars = new Map([
        ['DB_HOST', 'localhost'],
        ['DB_PORT', '5432'],
      ]);

      const config = {
        services: {
          data: {
            host: '${DB_HOST}',
            port: '${DB_PORT}',
          },
        },
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.services.data.host).toBe('localhost');
      // Type coercion happens for full variable substitution
      expect(result.services.data.port).toBe(5432);
    });

    it('should interpolate strings in arrays', () => {
      const envVars = new Map([['DOMAIN', 'example.com']]);

      const config = {
        allowedOrigins: ['https://${DOMAIN}', 'http://localhost'],
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.allowedOrigins[0]).toBe('https://example.com');
      expect(result.allowedOrigins[1]).toBe('http://localhost');
    });

    it('should preserve non-string types', () => {
      const envVars = new Map();

      const config = {
        port: 5432,
        enabled: true,
        timeout: null,
        tags: ['tag1', 'tag2'],
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.port).toBe(5432);
      expect(result.enabled).toBe(true);
      expect(result.timeout).toBe(null);
      expect(result.tags).toEqual(['tag1', 'tag2']);
    });

    it('should coerce types for full variable substitution', () => {
      const envVars = new Map([
        ['PORT', '5432'],
        ['ENABLED', 'true'],
        ['DISABLED', 'false'],
        ['NULL_VAR', 'null'],
      ]);

      const config = {
        port: '${PORT}',
        enabled: '${ENABLED}',
        disabled: '${DISABLED}',
        nullValue: '${NULL_VAR}',
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.port).toBe(5432);
      expect(result.enabled).toBe(true);
      expect(result.disabled).toBe(false);
      expect(result.nullValue).toBe(null);
    });

    it('should not coerce types for partial interpolation', () => {
      const envVars = new Map([['PORT', '5432']]);

      const config = {
        url: 'http://localhost:${PORT}',
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.url).toBe('http://localhost:5432');
      expect(typeof result.url).toBe('string');
    });

    it('should provide context in error messages', () => {
      const envVars = new Map();

      const config = {
        services: {
          auth: {
            issuer: '${AUTH_ISSUER}',
          },
        },
      };

      expect(() => {
        interpolateConfig(config, envVars);
      }).toThrow(/AUTH_ISSUER.*services\.auth\.issuer/);
    });

    it('should use default when variable is empty string', () => {
      const envVars = new Map([['EMPTY', '']]);

      const config = {
        value: '${EMPTY:-fallback}',
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.value).toBe('fallback');
    });

    it('should handle default values in nested config', () => {
      const envVars = new Map();

      const config = {
        services: {
          data: {
            port: '${DB_PORT:-5432}',
            host: '${DB_HOST:-localhost}',
          },
        },
      };

      const result = interpolateConfig(config, envVars) as any;

      expect(result.services.data.port).toBe(5432);
      expect(result.services.data.host).toBe('localhost');
    });
  });
});
