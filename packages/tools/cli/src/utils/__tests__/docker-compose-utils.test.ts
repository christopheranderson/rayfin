import { constants } from 'fs';
import { mkdir, rm, access, readFile } from 'fs/promises';
import os from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('docker-compose-utils', () => {
  let tempDir: string;
  let rayfinDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await mkdtemp(join(os.tmpdir(), 'rayfin-test-'));
    rayfinDir = join(tempDir, 'rayfin');
    await mkdir(rayfinDir, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Clean up temporary directory
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('copyOrOverwriteDockerComposeFile', () => {
    it('should create .temp directory and docker-compose.yml file', async () => {
      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');
      const result = await copyOrOverwriteDockerComposeFile(rayfinDir);

      // Check that the returned path is correct
      expect(result.path).toBe(join(rayfinDir, '.temp', 'docker-compose.yml'));
      expect(result.updated).toBe(true);

      // Check that the .temp directory was created
      await access(join(rayfinDir, '.temp'), constants.F_OK);

      // Check that the docker-compose.yml file was created
      await access(result.path, constants.F_OK);
    });

    it('should overwrite existing docker-compose.yml file', async () => {
      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');

      // Create .temp directory first
      const tempDirPath = join(rayfinDir, '.temp');
      await mkdir(tempDirPath, { recursive: true });

      // Create an existing docker-compose.yml file
      const existingFile = join(tempDirPath, 'docker-compose.yml');
      const { writeFile } = await import('fs/promises');
      await writeFile(existingFile, 'existing content');

      // Call copyOrOverwriteDockerComposeFile
      const result = await copyOrOverwriteDockerComposeFile(rayfinDir);

      // Check that the file was overwritten (it should not contain "existing content")
      const content = await readFile(result.path, 'utf8');
      expect(content).not.toContain('existing content');
      expect(content).toContain('Rayfin Docker Compose Configuration');
      expect(result.updated).toBe(true);
    });

    it("should create nested directories if they don't exist", async () => {
      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');

      // Don't create the rayfin directory beforehand
      const newRayfinDir = join(tempDir, 'nested', 'rayfin');

      const result = await copyOrOverwriteDockerComposeFile(newRayfinDir);

      // Check that nested directories were created
      await access(join(newRayfinDir, '.temp'), constants.F_OK);
      await access(result.path, constants.F_OK);
      expect(result.updated).toBe(true);
    });

    it('should not overwrite when CLI version matches', async () => {
      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');

      // First call - creates the file
      const firstResult = await copyOrOverwriteDockerComposeFile(rayfinDir);
      expect(firstResult.updated).toBe(true);

      // Second call - should skip overwriting since version matches
      const secondResult = await copyOrOverwriteDockerComposeFile(rayfinDir);
      expect(secondResult.updated).toBe(false);
      expect(secondResult.path).toBe(firstResult.path);
    });

    it('should include WEBSERVICE-IMAGE-NAME metadata in docker-compose.yml', async () => {
      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');
      const result = await copyOrOverwriteDockerComposeFile(rayfinDir);
      const content = await readFile(result.path, 'utf8');

      // Check that WEBSERVICE-IMAGE-NAME comment exists with a full image reference
      expect(content).toContain('# WEBSERVICE-IMAGE-NAME:');
      expect(content).toMatch(
        /# WEBSERVICE-IMAGE-NAME: [\w./:-]+(?:@[a-z0-9]+:[a-f0-9]+)?/
      );
    });

    it('should throw when CLI version is Unknown and no env var override', async () => {
      vi.resetModules();
      vi.doMock('../version.js', () => ({
        getPackageVersion: () => 'Unknown',
      }));

      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');
      await expect(copyOrOverwriteDockerComposeFile(rayfinDir)).rejects.toThrow(
        'Unable to determine CLI version for the webservice image'
      );
    });

    it('should use RAYFIN_WEBSERVICE_IMAGE_NAME env var when set', async () => {
      vi.stubEnv(
        'RAYFIN_WEBSERVICE_IMAGE_NAME',
        'my-registry.example.com/custom-image:v2'
      );
      vi.resetModules();

      const { copyOrOverwriteDockerComposeFile } =
        await import('../docker-compose-utils');
      const result = await copyOrOverwriteDockerComposeFile(rayfinDir);
      const content = await readFile(result.path, 'utf8');

      expect(content).toContain(
        'image: my-registry.example.com/custom-image:v2'
      );
      expect(content).toContain(
        '# WEBSERVICE-IMAGE-NAME: my-registry.example.com/custom-image:v2'
      );
    });
  });
});

// Helper function to create temporary directory (modern fs.mkdtemp equivalent)
async function mkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import('fs/promises');
  return mkdtemp(prefix);
}
