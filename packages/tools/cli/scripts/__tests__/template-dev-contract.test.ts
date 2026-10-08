import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const samplesDir = resolve(import.meta.dirname, '../../../../../samples');
const skippedDirectories = new Set(['node_modules', 'dist', '.temp', 'target']);

interface TemplateRoot {
  readonly name: string;
  readonly root: string;
  readonly packageJson: {
    readonly scripts?: Record<string, string>;
    readonly template?: { readonly hidden?: boolean; readonly name?: string };
    readonly workspaces?: readonly string[];
  };
}

function findTemplateRoots(): TemplateRoot[] {
  return readdirSync(samplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sampleRoot = join(samplesDir, entry.name);
      for (const root of [sampleRoot, join(sampleRoot, 'template')]) {
        const packagePath = join(root, 'package.json');
        if (!existsSync(packagePath)) continue;
        const packageJson = JSON.parse(
          readFileSync(packagePath, 'utf8')
        ) as TemplateRoot['packageJson'];
        if (packageJson.template) {
          return [{ name: entry.name, root, packageJson }];
        }
      }
      return [];
    });
}

function findPackageJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name)
        ? []
        : findPackageJsonFiles(join(directory, entry.name));
    }
    return entry.name === 'package.json' ? [join(directory, entry.name)] : [];
  });
}

const migratedSamples = findPackageJsonFiles(samplesDir).flatMap(
  (packagePath) => {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return packageJson.scripts?.dev === 'rayfin dev'
      ? [
          {
            name: packagePath.slice(samplesDir.length + 1),
            scripts: packageJson.scripts,
          },
        ]
      : [];
  }
);

const universalAppPackage = JSON.parse(
  readFileSync(
    join(samplesDir, 'universal-app', 'template', 'package.json'),
    'utf8'
  )
) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('bundled template dev scripts', () => {
  const templates = findTemplateRoots().map(({ name, packageJson }) => ({
    name,
    scripts: packageJson.scripts ?? {},
  }));

  it('routes the public dev script through rayfin dev', () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(template.scripts.dev, template.name).toBe('rayfin dev');
    }
  });

  it('provides a non-recursive frontend child script', () => {
    for (const template of templates) {
      const frontend = template.scripts['dev:frontend'];
      expect(frontend, template.name).toBeTruthy();
      expect(frontend, template.name).not.toMatch(/\brayfin\s+(?:dev|up)\b/);
      expect(template.scripts.predev, template.name).toBeUndefined();
    }
  });

  it('discovers the hidden Universal App from its inner workspace root', () => {
    const universalApp = findTemplateRoots().find(
      ({ name }) => name === 'universal-app'
    );

    expect(universalApp?.root).toBe(
      join(samplesDir, 'universal-app', 'template')
    );
    expect(universalApp?.packageJson.template).toMatchObject({
      hidden: true,
      name: 'universal-app',
      displayName: '✨ Use default template',
    });
    expect(universalApp?.packageJson.workspaces).toEqual(['packages/*']);
  });
});

describe('Universal App repository validation', () => {
  it('keeps skill-kit test dependencies out of generated apps', () => {
    expect(universalAppPackage.scripts?.['test:template']).toBe(
      'node scripts/run-template-tests.mjs'
    );
    expect(universalAppPackage.devDependencies?.ajv).toBeUndefined();
  });
});

describe('migrated sample dev scripts', () => {
  it('always provides a non-recursive frontend child', () => {
    expect(migratedSamples.length).toBeGreaterThan(4);
    for (const sample of migratedSamples) {
      const frontend = sample.scripts['dev:frontend'];
      expect(frontend, sample.name).toBeTruthy();
      expect(frontend, sample.name).not.toMatch(/\brayfin\s+(?:dev|up)\b/);
    }
  });
});

describe('bundled template dialect contract', () => {
  // A pinned dialect on a disabled data service is still sent to the backend
  // on `rayfin up` and locks the item's dialect. A data-disabled template must
  // therefore ship no dialect so the builder's later choice becomes the
  // initial (and only) dialect. See DataSettingsValidator on the host.
  const dataDisabledTemplates = findTemplateRoots().flatMap(
    ({ name, root }) => {
      const ymlPath = join(root, 'rayfin', 'rayfin.yml');
      if (!existsSync(ymlPath)) return [];
      const config = parse(readFileSync(ymlPath, 'utf8')) as {
        services?: { data?: { enabled?: boolean; dialect?: string } };
      } | null;
      const data = config?.services?.data;
      return data?.enabled === true ? [] : [{ name, data }];
    }
  );

  it('ships no dialect when the data service is disabled', () => {
    expect(dataDisabledTemplates.length).toBeGreaterThan(0);
    for (const template of dataDisabledTemplates) {
      expect(template.data?.dialect, template.name).toBeUndefined();
    }
  });
});
