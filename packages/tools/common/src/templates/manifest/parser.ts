import { readFile } from 'fs/promises';
import { join } from 'path';

import { parse as parseYaml } from 'yaml';

import type { TemplateManifest } from '../types.js';

import { validateManifest } from './validator.js';

const MANIFEST_FILENAME = 'rayfin-template.yml';

/**
 * Parse a rayfin-template.yml manifest from a directory.
 * Throws if the manifest is missing or invalid.
 */
export async function parseManifest(
  dirPath: string
): Promise<TemplateManifest> {
  const manifestPath = join(dirPath, MANIFEST_FILENAME);
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Template manifest not found: ${manifestPath}\n` +
        `Expected a ${MANIFEST_FILENAME} file in the template directory.`
    );
  }
  return parseManifestFromString(content);
}

/**
 * Parse a rayfin-template.yml manifest from a YAML string.
 * Throws if the YAML is malformed or the manifest is invalid.
 */
export function parseManifestFromString(content: string): TemplateManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new Error(
      `Invalid YAML in template manifest: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Template manifest must be a YAML object');
  }

  const errors = validateManifest(parsed);
  if (errors.length > 0) {
    throw new Error(
      `Invalid template manifest:\n${errors.map((e) => `  - ${e}`).join('\n')}`
    );
  }

  return parsed as TemplateManifest;
}
