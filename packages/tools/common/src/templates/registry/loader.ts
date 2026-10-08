import { readFile } from 'fs/promises';

import { parse as parseYaml } from 'yaml';

import type { RegistryEntry, TemplateRegistry } from '../types.js';
import { isGitUrl } from '../types.js';

/**
 * Load and parse a template-registries.yml file.
 * Returns empty registry if file doesn't exist.
 * Invalid entries are dropped with human-readable warnings.
 */
export async function loadRegistries(
  filePath: string
): Promise<TemplateRegistry> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = parseYaml(content);

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.registries)
    ) {
      return {
        registries: [],
        warnings: [`${filePath}: expected top-level 'registries' array`],
      };
    }

    const registries: RegistryEntry[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < parsed.registries.length; i++) {
      const r = parsed.registries[i];
      const prefix = `${filePath}[${i}]`;

      if (!r || typeof r !== 'object') {
        warnings.push(`${prefix}: entry must be an object`);
        continue;
      }

      const rec = r as Record<string, unknown>;

      if (typeof rec.name !== 'string' || rec.name === '') {
        warnings.push(`${prefix}: missing or invalid 'name' field`);
        continue;
      }
      if (typeof rec.url !== 'string' || rec.url === '') {
        warnings.push(
          `${prefix} (${rec.name}): missing or invalid 'url' field`
        );
        continue;
      }
      if (!isGitUrl(rec.url)) {
        warnings.push(
          `${prefix} (${rec.name}): url '${rec.url}' is not a valid git URL`
        );
        continue;
      }

      const malformedRefFields: Array<'ref' | 'alphaRef' | 'betaRef'> = [];

      const readRef = (
        field: 'ref' | 'alphaRef' | 'betaRef'
      ): string | undefined => {
        const value = rec[field];
        if (value !== undefined) {
          if (typeof value === 'string') {
            return value;
          }
          malformedRefFields.push(field);
          warnings.push(
            `${prefix} (${rec.name}): '${field}' must be a string; got ${typeof value} ` +
              `(${JSON.stringify(value)}). Quote the value (e.g. ${field}: "1.0") to preserve it. ` +
              `Entry will be loaded without this ref.`
          );
        }
        return undefined;
      };

      const ref = readRef('ref');
      const alphaRef = readRef('alphaRef');
      const betaRef = readRef('betaRef');

      registries.push({
        name: String(rec.name),
        displayName: String(rec.displayName || rec.name),
        description: rec.description ? String(rec.description) : undefined,
        url: String(rec.url),
        ref,
        alphaRef,
        betaRef,
        path: typeof rec.path === 'string' ? rec.path : undefined,
        templateName:
          typeof rec.templateName === 'string' ? rec.templateName : undefined,
        default: typeof rec.default === 'boolean' ? rec.default : undefined,
        firstClass:
          typeof rec.firstClass === 'boolean' ? rec.firstClass : undefined,
        malformedRefFields:
          malformedRefFields.length > 0 ? malformedRefFields : undefined,
      });
    }

    return { registries, warnings };
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return { registries: [], warnings: [] };
    }
    throw err;
  }
}
