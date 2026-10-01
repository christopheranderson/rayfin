import { constants } from 'fs';
import { mkdir, copyFile, readFile, access, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import path from 'path';
import { fileURLToPath } from 'url';

import { parse } from 'yaml';

import { getPackageVersion } from './version.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants for version extraction
const MAX_LINES_TO_SCAN = 10; // Number of lines to scan for CLI version comment

const WEBSERVICE_IMAGE_NAME_PLACEHOLDER = '{{WEBSERVICE_IMAGE_NAME}}';
const RAYFIN_WEBSERVICE_IMAGE_NAME = 'RAYFIN_WEBSERVICE_IMAGE_NAME';

function resolveWebserviceImageName(): string {
  const envOverride = process.env[RAYFIN_WEBSERVICE_IMAGE_NAME];
  if (envOverride) {
    return envOverride;
  }
  const cliVersion = getPackageVersion();
  if (cliVersion === 'Unknown') {
    throw new Error(
      'Unable to determine CLI version for the webservice image; reinstall the CLI or set RAYFIN_WEBSERVICE_IMAGE_NAME.'
    );
  }
  return `ghcr.io/microsoft/project-rayfin/webservice:cli-${cliVersion}`;
}

/**
 * Extracts the webservice image name from a docker-compose.yml file
 * @param dockerComposePath - The path to the docker-compose.yml file
 * @returns The webservice image name string or null if not found
 */
async function extractWebserviceImageNameFromComposeFile(
  dockerComposePath: string
): Promise<string | null> {
  try {
    const content = await readFile(dockerComposePath, 'utf-8');
    // Look for the WEBSERVICE-IMAGE-NAME comment in the first few lines
    const lines = content.split('\n').slice(0, MAX_LINES_TO_SCAN);
    for (const line of lines) {
      const match = line.match(/^#\s*WEBSERVICE-IMAGE-NAME:\s*(.+)$/);
      if (match) {
        return match[1].trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Creates the docker-compose.yml file in the .temp directory
 * Only overwrites if the CLI version has changed or the file doesn't exist
 * @param rayfinDir - The rayfin directory path
 * @returns Object with the path to the docker-compose.yml file and whether it was updated
 *
 * TODO: Once the repo/package is public, resolve the webservice image digest at runtime
 * by querying the GHCR OCI manifest API (no auth needed for public packages):
 *   GET https://ghcr.io/v2/microsoft/project-rayfin/webservice/manifests/cli-<version>
 * Then rewrite the image line to include \@sha256:<digest> for content-addressable pulls.
 * Third-party images (postgres, mssql, azurite, etc.) are already digest-pinned
 * in the template and updated via scripts/update-container-digests.sh.
 */
export async function copyOrOverwriteDockerComposeFile(
  rayfinDir: string,
  force?: boolean
): Promise<{ path: string; updated: boolean }> {
  // Create .temp directory
  const tempDir = join(rayfinDir, '.temp');
  await mkdir(tempDir, { recursive: true });

  // Define paths
  const assetsDir = resolve(__dirname, '..', '..', 'assets');
  const dockerComposeSourcePath = join(assetsDir, 'docker-compose.yml');
  const dockerComposePath = join(tempDir, 'docker-compose.yml');

  // Check if docker-compose.yml already exists
  let fileExists = false;
  try {
    await access(dockerComposePath, constants.F_OK);
    fileExists = true;
  } catch {
    // File doesn't exist, will be created
  }

  const webserviceImageName = resolveWebserviceImageName();

  if (fileExists && !force) {
    // Extract the webservice image name from the existing file
    const existingWebserviceImageName =
      await extractWebserviceImageNameFromComposeFile(dockerComposePath);

    if (
      existingWebserviceImageName === webserviceImageName &&
      existingWebserviceImageName !== null
    ) {
      // Version matches and is valid, skip overwriting
      return { path: dockerComposePath, updated: false };
    }
    // Version mismatch or no version found, will overwrite
  }

  // Copy docker-compose.yml from assets (either new file or version mismatch)
  await copyFile(dockerComposeSourcePath, dockerComposePath);

  // Replace version placeholder with actual webservice image name
  const fileContent = await readFile(dockerComposePath, 'utf-8');
  const updatedContent = fileContent.replaceAll(
    WEBSERVICE_IMAGE_NAME_PLACEHOLDER,
    webserviceImageName
  );
  await writeFile(dockerComposePath, updatedContent, 'utf-8');

  return { path: dockerComposePath, updated: true };
}

/**
 * Extracts all profile names from a docker-compose.yml file
 * @param dockerComposePath - The path to the docker-compose.yml file
 * @returns Array of unique profile names found in the file
 */
export async function extractProfilesFromComposeFile(
  dockerComposePath: string
): Promise<string[]> {
  try {
    const content = await readFile(dockerComposePath, 'utf-8');
    const composeConfig = parse(content);

    const profiles = new Set<string>();

    // Iterate through services and extract profiles
    if (composeConfig?.services) {
      for (const serviceName in composeConfig.services) {
        const service = composeConfig.services[serviceName];
        if (service?.profiles && Array.isArray(service.profiles)) {
          service.profiles.forEach((profile: string) => profiles.add(profile));
        }
      }
    }

    return Array.from(profiles);
  } catch (error: any) {
    // If we can't parse the file, return empty array (purge will work without profiles)
    console.warn(
      `Warning: Could not extract profiles from docker-compose.yml: ${error.message}`
    );
    return [];
  }
}
