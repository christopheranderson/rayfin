import {
  existsSync,
  mkdirSync,
  readFileSync,
  cpSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { stringify } from 'yaml';

import { createTestTemplate } from '../helpers/create-test-template.js';
import {
  runRayfinInit,
  listFiles,
  createTempDir,
  useTrackedCleanup,
  prependFakeNpmToPath,
  readRayfinYml,
} from '../helpers/run-cli.js';

const { track: trackCleanup } = useTrackedCleanup();

const testWorkspaceId = '11111111-1111-1111-1111-111111111111';
const testItemId = '22222222-2222-2222-2222-222222222222';

const pinnedRayfinPackageJson = JSON.stringify(
  {
    name: 'placeholder',
    version: '1.0.0',
    dependencies: {
      '@microsoft/rayfin-core': '1.2.3',
      '@microsoft/rayfin-data': '1.2.3',
      '@microsoft/rayfin-client': '1.2.3',
      '@microsoft/rayfin-auth-provider-fabric': '1.2.3',
    },
    devDependencies: {
      '@microsoft/rayfin-cli': '1.2.3',
    },
  },
  null,
  2
);

function writeLocalTemplateVariant(
  templateRoot: string,
  templatePath: string,
  variantName: string,
  marker: string
): void {
  const variantDir = join(templateRoot, ...templatePath.split('/'));
  mkdirSync(variantDir, { recursive: true });
  writeFileSync(
    join(variantDir, 'rayfin-template.yml'),
    stringify({
      apiVersion: 'v1',
      metadata: { name: variantName, displayName: variantName },
      entries: [{ name: variantName, path: '.' }],
    })
  );
  writeFileSync(
    join(variantDir, 'package.json'),
    JSON.stringify(
      { name: '{{projectName}}', version: '1.0.0', scripts: {} },
      null,
      2
    )
  );
  writeFileSync(join(variantDir, 'VARIANT.txt'), marker);
}

function createGroupedLocalTemplate(templateRoot: string): void {
  mkdirSync(templateRoot, { recursive: true });
  writeFileSync(
    join(templateRoot, 'rayfin-template.yml'),
    stringify({
      apiVersion: 'v1',
      metadata: {
        name: 'grouped-entry',
        displayName: 'Grouped Entry Template',
        description: 'Template with grouped entries',
      },
      entries: [
        {
          group: {
            name: 'starters',
            displayName: 'Starter Apps',
            entries: [
              { name: 'variant-a', path: 'starters/variant-a' },
              { name: 'variant-b', path: 'starters/variant-b' },
            ],
          },
        },
      ],
    })
  );
  writeLocalTemplateVariant(
    templateRoot,
    'starters/variant-a',
    'variant-a',
    'This is variant A\n'
  );
  writeLocalTemplateVariant(
    templateRoot,
    'starters/variant-b',
    'variant-b',
    'This is variant B\n'
  );
}

function createFlatLocalTemplate(templateRoot: string): void {
  mkdirSync(templateRoot, { recursive: true });
  writeFileSync(
    join(templateRoot, 'rayfin-template.yml'),
    stringify({
      apiVersion: 'v1',
      metadata: {
        name: 'flat-entry',
        displayName: 'Flat Entry Template',
        description: 'Template with flat entries',
      },
      entries: [
        { name: 'variant-a', path: 'variant-a' },
        { name: 'variant-b', path: 'variant-b' },
      ],
    })
  );
  writeLocalTemplateVariant(
    templateRoot,
    'variant-a',
    'variant-a',
    'This is variant A\n'
  );
  writeLocalTemplateVariant(
    templateRoot,
    'variant-b',
    'variant-b',
    'This is variant B\n'
  );
}

/**
 * Asserts the canonical project-root `.gitignore` contract per ADO #2090326.
 *
 * The contract is **line presence**, not byte-for-byte equality with the
 * asset: the project-root `.gitignore` MUST exist and MUST contain every
 * canonical Rayfin line so `git status` is clean from the start. Either
 * mechanism — writing the canonical asset on net-new files, or merging the
 * missing canonical lines into an existing template-author file — satisfies
 * the contract. So this assertion uses line-anchored Set membership (not
 * substring `.toContain`, so the assertion can't be satisfied by a
 * commented-out line containing the same token), which passes for both
 * the bundled-template overwrite path and the external-template merge path.
 *
 * Covers the full enumeration from the "Project-root .gitignore" requirement
 * in `openspec/specs/rayfin-cli-init/spec.md` so a future edit to the asset
 * that drops a category — `*.local`, `.vite`, log family, etc. — fails CI
 * here instead of silently breaking scaffolded projects.
 */
function expectCanonicalGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  expect(existsSync(gitignorePath)).toBe(true);
  const lines = new Set(
    readFileSync(gitignorePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
  );
  for (const required of [
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*',
    'lerna-debug.log*',
    'node_modules',
    'dist',
    'dist-ssr',
    '*.tsbuildinfo',
    '.vite',
    'coverage',
    '*.local',
    'rayfin/.env*',
    'rayfin/.deployments.json',
    'rayfin/.temp/',
    '.idea',
    '.DS_Store',
    '*.suo',
    '*.ntvs*',
    '*.njsproj',
    '*.sln',
    '*.sw?',
  ]) {
    expect(lines.has(required)).toBe(true);
  }
}

function expectPinnedRayfinPackageVersions(projectDir: string): void {
  const packageJson = JSON.parse(
    readFileSync(join(projectDir, 'package.json'), 'utf8')
  );
  expect(packageJson.dependencies).toMatchObject({
    '@microsoft/rayfin-core': '1.2.3',
    '@microsoft/rayfin-data': '1.2.3',
    '@microsoft/rayfin-client': '1.2.3',
    '@microsoft/rayfin-auth-provider-fabric': '1.2.3',
  });
  expect(packageJson.devDependencies).toMatchObject({
    '@microsoft/rayfin-cli': '1.2.3',
  });
}

// ─── Bundled Templates ────────────────────────────────────────────────────────

describe('rayfin init — bundled templates', () => {
  it('scaffolds a bundled template', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'test-app',
        '--skip-install',
        'test-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'test-app');
    expect(existsSync(projectDir)).toBe(true);

    const packageJson = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );
    expect(packageJson.name).toBe('test-app');
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe('module');
    expect(packageJson.dependencies).toHaveProperty('@microsoft/rayfin-core');
    expect(packageJson.devDependencies).toHaveProperty('@microsoft/rayfin-cli');

    const rayfinYml = join(projectDir, 'rayfin', 'rayfin.yml');
    expect(existsSync(rayfinYml)).toBe(true);
  });

  it('stamps current Rayfin package versions for bundled templates', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'Bundled Latest App',
        '--skip-install',
        'bundled-latest-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const packageJson = JSON.parse(
      readFileSync(join(tmp.dir, 'bundled-latest-app', 'package.json'), 'utf8')
    );
    // Versions may be exact pins or caret ranges, including prereleases.
    expect(packageJson.dependencies['@microsoft/rayfin-core']).toMatch(
      /^\^?\d+\.\d+\.\d+/
    );
    expect(packageJson.dependencies['@microsoft/rayfin-client']).toMatch(
      /^\^?\d+\.\d+\.\d+/
    );
    expect(packageJson.devDependencies['@microsoft/rayfin-cli']).toMatch(
      /^\^?\d+\.\d+\.\d+/
    );
  });

  it('positional <appname> doubles as project name when --project-name omitted', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      ['--template', 'dataapp', '--skip-install', 'my-positional-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'my-positional-app');
    expect(existsSync(projectDir)).toBe(true);

    const config = readRayfinYml(projectDir);
    expect(config.id).toBe('my-positional-app');
    expect(config.name).toBe('my-positional-app');

    const packageJson = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );
    expect(packageJson.name).toBe('my-positional-app');

    expectCanonicalGitignore(projectDir);

    expect(result.stderr).toMatch(/Next steps:/);
    expect(result.stderr).toMatch(/^\s*cd my-positional-app$/m);
    expect(result.stderr).toMatch(/^\s*npx rayfin dev$/m);
    expect(result.stderr).not.toMatch(/^\s*npm run dev$/m);
  });

  it('--project-name overrides positional when both are provided', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'Custom Name',
        '--skip-install',
        'my-dir',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'my-dir');
    expect(existsSync(projectDir)).toBe(true);

    const config = readRayfinYml(projectDir);
    expect(config.name).toBe('Custom Name');
    expect(config.id).toBe('custom-name');
  });

  it('lists templates as JSON', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(['-l'], { cwd: tmp.dir });

    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output).toHaveProperty('bundled');
    expect(Array.isArray(output.bundled)).toBe(true);
    expect(output.bundled.length).toBeGreaterThanOrEqual(1);

    for (const entry of output.bundled) {
      expect(entry).toHaveProperty('name');
      expect(typeof entry.name).toBe('string');
    }
  });

  it('exits with error for unknown template', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      ['--template', 'nonexistent-template', 'test-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/not found/i);
  });
});

// ─── Bundled Templates Param Flow-Through ─────────────────────────────────────

describe('rayfin init — bundled templates param flow-through', () => {
  it('--project-name flows to rayfin.yml name and id', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'My Test App',
        '--skip-install',
        'my-test-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'my-test-app');
    const config = readRayfinYml(projectDir);
    expect(config.name).toBe('My Test App');
    expect(config.id).toBe('my-test-app');
  });

  it('--dialect postgresql flows to rayfin.yml', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'dialect-test',
        '--dialect',
        'postgresql',
        '--skip-install',
        'dialect-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'dialect-test');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    expect(data.dialect).toBe('postgresql');
  });

  it('--workspace-id and --item-id seed deployments registry', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'fabric-test',
        '--workspace-id',
        testWorkspaceId,
        '--item-id',
        testItemId,
        '--skip-install',
        'fabric-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'fabric-test');
    const registryPath = join(projectDir, 'rayfin', '.deployments.json');
    expect(existsSync(registryPath)).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.active).toBeDefined();
    const activeName: string = registry.active;
    expect(registry.deployments[activeName].fabricWorkspaceId).toBe(
      testWorkspaceId
    );
    expect(registry.deployments[activeName].fabricItemId).toBe(testItemId);
  });

  it('--item-id without --workspace-id warns and ignores', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'warn-test',
        '--item-id',
        'item-123',
        '--skip-install',
        'warn-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/--item-id requires --workspace-id/i);

    const projectDir = join(tmp.dir, 'warn-test');
    expect(existsSync(join(projectDir, 'rayfin', '.deployments.json'))).toBe(
      false
    );
  });

  it('--base-api-url persists into rayfin/.env for subsequent commands', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'api-url-test',
        '--base-api-url',
        'https://dxtapi.fabric.microsoft.com',
        '--skip-install',
        'api-url-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'api-url-test');
    const envPath = join(projectDir, 'rayfin', '.env');
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, 'utf8');
    expect(envContent).toMatch(
      /^RAYFIN_FABRIC_API_URL=https:\/\/dxtapi\.fabric\.microsoft\.com\/v1$/m
    );
  });

  it('--workspace-uri persists derived API+portal URLs into rayfin/.env', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'workspace-uri-test',
        '--workspace-uri',
        'https://dxt.fabric.microsoft.com/groups/00000000-0000-0000-0000-000000000001/list',
        '--skip-install',
        'workspace-uri-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'workspace-uri-test');
    const envPath = join(projectDir, 'rayfin', '.env');
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, 'utf8');
    expect(envContent).toMatch(/^RAYFIN_FABRIC_API_URL=https:\/\/.+$/m);
    expect(envContent).toMatch(/^RAYFIN_FABRIC_PORTAL_URL=https:\/\/.+$/m);
  });

  it('on user-cancelled overwrite, exits 2 without persisting Fabric env', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = join(tmp.dir, 'cancel-existing-bundled');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'IMPORTANT.txt'), 'do not delete\n');

    const result = await runRayfinInit(
      [
        '--template',
        'dataapp',
        '--project-name',
        'cancel-test-bundled',
        '--skip-install',
        '--base-api-url',
        'https://api.fabric.microsoft.com/v1',
        'cancel-existing-bundled',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/Operation cancelled/i);

    expect(existsSync(join(projectDir, 'IMPORTANT.txt'))).toBe(true);
    expect(existsSync(join(projectDir, 'rayfin', '.env'))).toBe(false);
  });
});

// ─── All Bundled Templates Scaffold Successfully ──────────────────────────────

describe('rayfin init — all bundled templates scaffold successfully', () => {
  const BUNDLED_TEMPLATES = ['dataapp', 'gettingstartedauth', 'todoapp'];

  for (const templateName of BUNDLED_TEMPLATES) {
    it(`scaffolds ${templateName} with expected structure`, async () => {
      const tmp = createTempDir();
      trackCleanup(tmp.cleanup);

      const result = await runRayfinInit(
        [
          '--template',
          templateName,
          '--project-name',
          'test-app',
          '--skip-install',
          'test-app',
        ],
        { cwd: tmp.dir }
      );

      expect(result.exitCode).toBe(0);
      const projectDir = join(tmp.dir, 'test-app');
      expect(existsSync(projectDir)).toBe(true);

      expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
      const packageJson = JSON.parse(
        readFileSync(join(projectDir, 'package.json'), 'utf8')
      );
      expect(packageJson.name).toBe('test-app');

      const rayfinYml = join(projectDir, 'rayfin', 'rayfin.yml');
      expect(existsSync(rayfinYml)).toBe(true);
      const yml = readRayfinYml(projectDir);
      expect(yml.id).toBe('test-app');

      expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(true);

      expect(existsSync(join(projectDir, 'node_modules'))).toBe(false);
      expect(existsSync(join(projectDir, 'dist'))).toBe(false);
      expect(existsSync(join(projectDir, '.tsbuildinfo'))).toBe(false);
      expect(existsSync(join(projectDir, '.templateignore'))).toBe(false);

      expectCanonicalGitignore(projectDir);
    }, 30_000);
  }
});

// ─── External Templates ───────────────────────────────────────────────────────

describe('rayfin init — external templates', () => {
  it('scaffolds from a file:// URL', async () => {
    const template = createTestTemplate({
      name: 'file-url-test',
      files: {
        'package.json': JSON.stringify(
          { name: '{{projectName}}', version: '1.0.0' },
          null,
          2
        ),
        'src/index.ts': 'export const hello = "world";\n',
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      ['-t', template.fileUrl, '--skip-install', 'test-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'test-app');
    expect(existsSync(projectDir)).toBe(true);

    const files = listFiles(projectDir);
    expect(files).toContain('src/index.ts');
    expect(files).not.toContain('rayfin-template.yml');

    expect(result.stderr).toMatch(/Next steps:/);
    expect(result.stderr).toMatch(/^\s*cd test-app$/m);
    expect(result.stderr).toMatch(/^\s*npx rayfin dev$/m);
    expect(result.stderr).not.toMatch(/^\s*npm run dev$/m);
  });

  it('substitutes project name in package.json and README content', async () => {
    const template = createTestTemplate({
      name: 'project-name-substitution-test',
      files: {
        'package.json': JSON.stringify(
          { name: 'hello-world', version: '1.0.0' },
          null,
          2
        ),
        'README.md':
          '# {{PROJECT_NAME}}\n\nSlug: {{PROJECT_NAME_KEBAB}}\n\nClass: {{PROJECT_NAME_PASCAL}}\n',
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'My Cool App',
        '--skip-install',
        'test-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'test-app');
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    );
    expect(packageJson.name).toBe('my-cool-app');

    const readme = readFileSync(join(projectDir, 'README.md'), 'utf8');
    expect(readme).toContain('My Cool App');
    expect(readme).toContain('my-cool-app');
    expect(readme).toContain('MyCoolApp');
    expect(readme).not.toContain('{{PROJECT_NAME}}');
    expect(readme).not.toContain('{{PROJECT_NAME_KEBAB}}');
    expect(readme).not.toContain('{{PROJECT_NAME_PASCAL}}');
  });

  it('preserves Rayfin package versions pinned by external templates', async () => {
    const template = createTestTemplate({
      name: 'external-pinned-rayfin-deps',
      files: {
        'package.json': pinnedRayfinPackageJson,
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const restorePath = prependFakeNpmToPath(join(tmp.dir, 'fake-bin'));
    let result: Awaited<ReturnType<typeof runRayfinInit>>;
    try {
      result = await runRayfinInit(
        [
          '-t',
          template.fileUrl,
          '--project-name',
          'Pinned External App',
          'pinned-external-app',
        ],
        { cwd: tmp.dir }
      );
    } finally {
      restorePath();
    }

    expect(result.exitCode).toBe(0);
    expectPinnedRayfinPackageVersions(join(tmp.dir, 'pinned-external-app'));
  });

  it('scaffolds from a local relative path', async () => {
    const template = createTestTemplate({
      name: 'local-path-test',
      files: {
        'package.json': JSON.stringify(
          { name: '{{projectName}}', version: '1.0.0' },
          null,
          2
        ),
        'README.md': '# Test\n',
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const localTemplatePath = join(tmp.dir, 'my-template');
    mkdirSync(localTemplatePath, { recursive: true });
    cpSync(template.path, localTemplatePath, { recursive: true });

    const result = await runRayfinInit(
      ['-t', './my-template', '--skip-install', 'test-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'test-app');
    expect(existsSync(projectDir)).toBe(true);

    const files = listFiles(projectDir);
    expect(files).toContain('README.md');
  });

  it('preserves Rayfin package versions pinned by local templates', async () => {
    const template = createTestTemplate({
      name: 'local-pinned-rayfin-deps',
      files: {
        'package.json': pinnedRayfinPackageJson,
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const localTemplatePath = join(tmp.dir, 'my-template');
    mkdirSync(localTemplatePath, { recursive: true });
    cpSync(template.path, localTemplatePath, { recursive: true });

    const restorePath = prependFakeNpmToPath(join(tmp.dir, 'fake-bin'));
    let result: Awaited<ReturnType<typeof runRayfinInit>>;
    try {
      result = await runRayfinInit(
        [
          '-t',
          './my-template',
          '--project-name',
          'Pinned Local App',
          'pinned-local-app',
        ],
        { cwd: tmp.dir }
      );
    } finally {
      restorePath();
    }

    expect(result.exitCode).toBe(0);
    expectPinnedRayfinPackageVersions(join(tmp.dir, 'pinned-local-app'));
  });

  // ── Sync-mode .gitignore + rayfin.yml preservation ─────────────────────
  // The post-scaffold pipeline always invokes `rayfin init --from-template`,
  // so external templates and re-runs hit the sync-mode contract for both
  // managed scaffold files. The previous behavior clobbered both — losing
  // template-author and user customizations. The current contract is:
  //   - `.gitignore` is MERGED: the template author's lines are preserved
  //     and the canonical Rayfin patterns are appended only if missing
  //     (idempotent re-run leaves the file unchanged).
  //   - `rayfin.yml` is MINIMALLY edited: only `id`/`name` (when renaming
  //     via `--project-name`) and `services.data.dialect` (when `--dialect`
  //     is passed and the template has a data block) are written. The rest
  //     of the template author's `services` block survives intact.

  it('merges Rayfin patterns into a template-shipped root .gitignore without losing author lines', async () => {
    const template = createTestTemplate({
      name: 'gitignore-merge-external',
      files: {
        'package.json': JSON.stringify(
          { name: '{{projectName}}', version: '1.0.0' },
          null,
          2
        ),
        '.gitignore':
          '# template-author-curated sentinel\nTEMPLATE_AUTHOR_LINE\nmy-template-cache/\n',
        'src/index.ts': 'export const hello = "world";\n',
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      ['-t', template.fileUrl, '--skip-install', 'test-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const gitignorePath = join(tmp.dir, 'test-app', '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf8');

    // Template-author lines survive the merge.
    expect(content).toContain('# template-author-curated sentinel');
    expect(content).toContain('TEMPLATE_AUTHOR_LINE');
    expect(content).toContain('my-template-cache/');

    // The canonical Rayfin-required patterns are now present.
    const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    for (const required of [
      'rayfin/.env*',
      'rayfin/.deployments.json',
      'rayfin/.temp/',
    ]) {
      expect(lines.has(required)).toBe(true);
    }

    // The appended block is labeled so the addition is diff-visible.
    expect(content).toContain('# Added by Rayfin CLI');
  }, 30_000);

  it('leaves a customized root .gitignore unchanged on idempotent `init --from-template` re-run', async () => {
    const template = createTestTemplate({
      name: 'gitignore-merge-resync',
      files: {
        'package.json': JSON.stringify(
          { name: '{{projectName}}', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const firstScaffold = await runRayfinInit(
      ['-t', template.fileUrl, '--skip-install', 'test-app'],
      { cwd: tmp.dir }
    );
    expect(firstScaffold.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'test-app');
    const gitignorePath = join(projectDir, '.gitignore');

    // Simulate a user manually editing the file after the first scaffold.
    const customized = readFileSync(gitignorePath, 'utf8') + '\nUSER_CUSTOM\n';
    writeFileSync(gitignorePath, customized);

    const resync = await runRayfinInit(
      ['--from-template', '--project-name=test-app', '--skip-install', '.'],
      { cwd: projectDir }
    );
    expect(resync.exitCode).toBe(0);

    const after = readFileSync(gitignorePath, 'utf8');
    // User customization survives: no clobber of user state.
    expect(after).toContain('USER_CUSTOM');
    // Canonical patterns are still present.
    const lines = new Set(after.split(/\r?\n/).map((line) => line.trim()));
    expect(lines.has('rayfin/.env*')).toBe(true);
    // No duplicate canonical patterns appended on re-run.
    const occurrences = after
      .split(/\r?\n/)
      .filter((l) => l.trim() === 'rayfin/.env*');
    expect(occurrences).toHaveLength(1);
  }, 30_000);

  it('does not bolt default scaffolding onto an external template-shipped rayfin.yml', async () => {
    // External templates author rayfin.yml deliberately. Sync mode must
    // NOT inject `customClaims`, `scopes`, `password`,
    // `allowedRedirectUris`, `staticHosting`, or `functions` blocks the
    // template never opted into — that pollutes the template author's
    // configuration with the bundled-template's default shape.
    const minimalRayfinYml = [
      'id: my-ext-id',
      'name: my-ext',
      'services:',
      '  auth:',
      '    enabled: true',
      '  data:',
      '    enabled: false',
      '  storage:',
      '    enabled: false',
      '',
    ].join('\n');

    const template = createTestTemplate({
      name: 'rayfin-yml-preservation-external',
      files: {
        'package.json': JSON.stringify(
          { name: '{{projectName}}', version: '1.0.0' },
          null,
          2
        ),
        'rayfin/rayfin.yml': minimalRayfinYml,
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'My Test App',
        '--skip-install',
        'test-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const config = readRayfinYml(join(tmp.dir, 'test-app'));
    const services = config.services as Record<string, unknown>;
    const auth = services.auth as Record<string, unknown>;

    // Identity edits the user opted into via --project-name.
    expect(config.name).toBe('My Test App');
    expect(config.id).toBe('my-test-app');

    // Auth block is preserved exactly as authored — no defaults bolted on.
    expect(auth.enabled).toBe(true);
    expect(auth.customClaims).toBeUndefined();
    expect(auth.scopes).toBeUndefined();
    expect(auth.password).toBeUndefined();
    expect(auth.allowedRedirectUris).toBeUndefined();

    // Services the template never opted into are not synthesized.
    expect(services.staticHosting).toBeUndefined();
    expect(services.functions).toBeUndefined();
  }, 30_000);
});

// ─── External Templates Param Flow-Through ────────────────────────────────────

describe('rayfin init — external templates param flow-through', () => {
  it('--project-name flows to rayfin.yml name and id', async () => {
    const template = createTestTemplate({
      name: 'ext-project-name-flow',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'My External App',
        '--skip-install',
        'my-external-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'my-external-app');
    const config = readRayfinYml(projectDir);
    expect(config.name).toBe('My External App');
    expect(config.id).toBe('my-external-app');
  });

  it('--dialect postgresql flows to rayfin.yml', async () => {
    const template = createTestTemplate({
      name: 'ext-dialect-flow',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'dialect-test',
        '--dialect',
        'postgresql',
        '--skip-install',
        'dialect-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'dialect-test');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    expect(data.dialect).toBe('postgresql');
  });

  it('--workspace-id and --item-id seed deployments registry', async () => {
    const template = createTestTemplate({
      name: 'ext-fabric-flow',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'fabric-test',
        '--workspace-id',
        testWorkspaceId,
        '--item-id',
        testItemId,
        '--skip-install',
        'fabric-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'fabric-test');
    const registryPath = join(projectDir, 'rayfin', '.deployments.json');
    expect(existsSync(registryPath)).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.active).toBeDefined();
    const activeName: string = registry.active;
    expect(registry.deployments[activeName].fabricWorkspaceId).toBe(
      testWorkspaceId
    );
    expect(registry.deployments[activeName].fabricItemId).toBe(testItemId);
  });

  it('--item-id without --workspace-id warns and ignores', async () => {
    const template = createTestTemplate({
      name: 'ext-itemid-warn',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'warn-test',
        '--item-id',
        'item-orphan',
        '--skip-install',
        'warn-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/--item-id requires --workspace-id/i);

    const projectDir = join(tmp.dir, 'warn-test');
    expect(existsSync(join(projectDir, 'rayfin', '.deployments.json'))).toBe(
      false
    );
  });

  it('skips install when external template has no package.json (no warning)', async () => {
    const template = createTestTemplate({
      name: 'ext-no-pkg-json',
      files: {
        'README.md': '# No package.json here\n',
        'src/index.ts': 'export const x = 1;\n',
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      ['-t', template.fileUrl, '--project-name', 'no-pkg-app', 'no-pkg-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toMatch(/npm install failed/i);
    expect(result.output).not.toMatch(/yarn install failed/i);
    expect(result.output).not.toMatch(/pnpm install failed/i);

    const projectDir = join(tmp.dir, 'no-pkg-app');
    expect(existsSync(join(projectDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(projectDir, 'src/index.ts'))).toBe(true);
  });

  it('honors --skip-install when template ships a package.json with deps', async () => {
    const template = createTestTemplate({
      name: 'ext-skip-install',
      files: {
        'package.json': JSON.stringify(
          {
            name: 'placeholder',
            version: '1.0.0',
            dependencies: { 'left-pad': '^1.3.0' },
          },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'skip-install-test',
        '--skip-install',
        'skip-install-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);
    const projectDir = join(tmp.dir, 'skip-install-test');
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'node_modules'))).toBe(false);
    expect(result.output).not.toMatch(/Installing dependencies/i);
  });

  it('on user-cancelled overwrite, returns cleanly without persisting Fabric env', async () => {
    const template = createTestTemplate({
      name: 'ext-cancel-overwrite',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const projectDir = join(tmp.dir, 'existing-app');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'IMPORTANT.txt'), 'do not delete\n');

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'cancel-test',
        '--skip-install',
        '--base-api-url',
        'https://api.fabric.microsoft.com/v1',
        'existing-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/Operation cancelled/i);
    expect(result.output).not.toMatch(/Skipping Fabric env persistence/);
    expect(result.output).not.toMatch(/scaffolded template does not include/i);

    expect(existsSync(join(projectDir, 'IMPORTANT.txt'))).toBe(true);
    expect(existsSync(join(projectDir, 'rayfin', '.env'))).toBe(false);
  });

  it('on user-cancelled in-place overwrite (external, non-interactive, .), exits 2 without wiping cwd', async () => {
    const template = createTestTemplate({
      name: 'ext-inplace-cancel',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const cwd = join(tmp.dir, 'inplace-cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'IMPORTANT.txt'), 'do not delete\n');

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'inplace-test',
        '--skip-install',
        '--base-api-url',
        'https://api.fabric.microsoft.com/v1',
        '.',
      ],
      { cwd }
    );

    expect(result.exitCode).toBe(2);
    expect(existsSync(join(cwd, 'IMPORTANT.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'rayfin', '.env'))).toBe(false);
  });

  it('updates pre-existing rayfin.yml in template (preserve+update branch)', async () => {
    const baselineYml = stringify({
      id: 'baseline-id',
      name: 'Baseline',
      version: '0.0.1',
      services: {
        data: { enabled: true, dialect: 'mssql' },
      },
    });

    const template = createTestTemplate({
      name: 'ext-pre-existing-yml',
      files: {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
        'rayfin/rayfin.yml': baselineYml,
      },
    });
    trackCleanup(template.cleanup);

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        template.fileUrl,
        '--project-name',
        'Updated Name',
        '--dialect',
        'postgresql',
        '--skip-install',
        'updated-name',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'updated-name');
    const config = readRayfinYml(projectDir);
    expect(config.name).toBe('Updated Name');
    const services = config.services as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    expect(data.dialect).toBe('postgresql');
    expect(config.version).toBe('0.0.1');
  });
});

// ─── Local Templates Param Flow-Through ───────────────────────────────────────

describe('rayfin init — local templates param flow-through', () => {
  function createLocalTemplate(
    name: string,
    files: Record<string, string>,
    cwd: string
  ): { localPath: string; cleanup: () => void } {
    const remote = createTestTemplate({ name, files });
    const localPath = join(cwd, name);
    mkdirSync(localPath, { recursive: true });
    cpSync(remote.path, localPath, { recursive: true });
    return { localPath, cleanup: remote.cleanup };
  }

  it('--project-name flows to rayfin.yml name and id', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tpl = createLocalTemplate(
      'local-name-flow',
      {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
      tmp.dir
    );
    trackCleanup(tpl.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        './local-name-flow',
        '--project-name',
        'My Local App',
        '--skip-install',
        'my-local-app',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'my-local-app');
    const config = readRayfinYml(projectDir);
    expect(config.name).toBe('My Local App');
    expect(config.id).toBe('my-local-app');
  });

  it('--dialect postgresql flows to rayfin.yml', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tpl = createLocalTemplate(
      'local-dialect-flow',
      {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
      tmp.dir
    );
    trackCleanup(tpl.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        './local-dialect-flow',
        '--project-name',
        'dialect-local',
        '--dialect',
        'postgresql',
        '--skip-install',
        'dialect-local',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'dialect-local');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    expect(data.dialect).toBe('postgresql');
  });

  it('--workspace-id and --item-id seed deployments registry', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tpl = createLocalTemplate(
      'local-fabric-flow',
      {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
      tmp.dir
    );
    trackCleanup(tpl.cleanup);

    const result = await runRayfinInit(
      [
        '-t',
        './local-fabric-flow',
        '--project-name',
        'fabric-local',
        '--workspace-id',
        testWorkspaceId,
        '--item-id',
        testItemId,
        '--skip-install',
        'fabric-local',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'fabric-local');
    const registryPath = join(projectDir, 'rayfin', '.deployments.json');
    expect(existsSync(registryPath)).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.active).toBeDefined();
    const activeName: string = registry.active;
    expect(registry.deployments[activeName].fabricWorkspaceId).toBe(
      testWorkspaceId
    );
    expect(registry.deployments[activeName].fabricItemId).toBe(testItemId);
  });

  it('positional <appname> doubles as project name when --project-name omitted', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tpl = createLocalTemplate(
      'local-positional-tpl',
      {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
      tmp.dir
    );
    trackCleanup(tpl.cleanup);

    const result = await runRayfinInit(
      ['-t', './local-positional-tpl', '--skip-install', 'my-positional-local'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'my-positional-local');
    const config = readRayfinYml(projectDir);
    expect(config.id).toBe('my-positional-local');

    expect(result.stderr).toMatch(/Next steps:/);
    expect(result.stderr).toMatch(/^\s*cd my-positional-local$/m);
    expect(result.stderr).toMatch(/^\s*npx rayfin dev$/m);
    expect(result.stderr).not.toMatch(/^\s*npm run dev$/m);
  });

  it('on user-cancelled overwrite, exits 2 without persisting Fabric env', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tpl = createLocalTemplate(
      'local-cancel-overwrite',
      {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
      tmp.dir
    );
    trackCleanup(tpl.cleanup);

    const projectDir = join(tmp.dir, 'cancel-existing-local');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'IMPORTANT.txt'), 'do not delete\n');

    const result = await runRayfinInit(
      [
        '-t',
        './local-cancel-overwrite',
        '--project-name',
        'cancel-test-local',
        '--skip-install',
        '--base-api-url',
        'https://api.fabric.microsoft.com/v1',
        'cancel-existing-local',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/Operation cancelled/i);

    expect(existsSync(join(projectDir, 'IMPORTANT.txt'))).toBe(true);
    expect(existsSync(join(projectDir, 'rayfin', '.env'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'treats Windows ".\\\\" form as in-place (no overwrite prompt or wipe)',
    async () => {
      const templateHost = createTempDir();
      trackCleanup(templateHost.cleanup);

      const tpl = createLocalTemplate(
        'in-place-windows-tpl',
        {
          'package.json': JSON.stringify(
            { name: 'placeholder', version: '1.0.0' },
            null,
            2
          ),
        },
        templateHost.dir
      );
      trackCleanup(tpl.cleanup);

      const sentinelDir = createTempDir();
      trackCleanup(sentinelDir.cleanup);
      writeFileSync(
        join(sentinelDir.dir, 'sentinel.txt'),
        'do-not-delete-me',
        'utf8'
      );

      const result = await runRayfinInit(
        ['-t', tpl.localPath, '--skip-install', '--overwrite', '.\\'],
        { cwd: sentinelDir.dir }
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(sentinelDir.dir, 'sentinel.txt'))).toBe(true);
      expect(readFileSync(join(sentinelDir.dir, 'sentinel.txt'), 'utf8')).toBe(
        'do-not-delete-me'
      );
      expect(existsSync(join(sentinelDir.dir, 'package.json'))).toBe(true);
    }
  );

  it('on user-cancelled in-place overwrite (local, non-interactive, .), exits 2 without wiping cwd', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tpl = createLocalTemplate(
      'local-inplace-cancel',
      {
        'package.json': JSON.stringify(
          { name: 'placeholder', version: '1.0.0' },
          null,
          2
        ),
      },
      tmp.dir
    );
    trackCleanup(tpl.cleanup);

    const cwd = join(tmp.dir, 'inplace-cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'IMPORTANT.txt'), 'do not delete\n');

    const result = await runRayfinInit(
      [
        '-t',
        join(tmp.dir, 'local-inplace-cancel'),
        '--project-name',
        'inplace-test',
        '--skip-install',
        '--base-api-url',
        'https://api.fabric.microsoft.com/v1',
        '.',
      ],
      { cwd }
    );

    expect(result.exitCode).toBe(2);
    expect(existsSync(join(cwd, 'IMPORTANT.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'rayfin', '.env'))).toBe(false);
  });
});

// ─── --services Flag ──────────────────────────────────────────────────────────

describe('rayfin init — --services flag', () => {
  it('--services auth,data enables both services in rayfin.yml', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'services-both',
        '--services',
        'auth,data',
        '--skip-install',
        'services-both',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'services-both');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const auth = services.auth as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    expect(auth.enabled).toBe(true);
    expect(data.enabled).toBe(true);
  });

  it('--services auth,data creates rayfin/data/ directory', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'services-data-dir',
        '--services',
        'auth,data',
        '--skip-install',
        'services-data-dir',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'services-data-dir');
    expect(existsSync(join(projectDir, 'rayfin', 'data'))).toBe(true);
  });

  it('bundled template todoapp always enables auth regardless of --services', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    // Even when passing --services data only, the bundled template's
    // own rayfin.yml takes precedence and enables auth
    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'services-data-only',
        '--services',
        'data',
        '--skip-install',
        'services-data-only',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'services-data-only');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    // Bundled template always ships auth enabled
    const auth = services.auth as Record<string, unknown>;
    expect(auth.enabled).toBe(true);
  });

  it('--services storage enables storage when the storage flag is set', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'services-add-storage',
        '--services',
        'storage',
        '--skip-install',
        'services-add-storage',
      ],
      { cwd: tmp.dir, env: { RAYFIN_FEATURE_FLAGS: 'storage' } }
    );

    expect(result.exitCode).toBe(0);

    const config = readRayfinYml(join(tmp.dir, 'services-add-storage'));
    const services = config.services as Record<string, unknown>;
    const auth = services.auth as Record<string, unknown>;
    const data = services.data as Record<string, unknown>;
    const storage = services.storage as Record<string, unknown>;
    expect(auth.enabled).toBe(true);
    expect(data.enabled).toBe(true);
    expect(storage.enabled).toBe(true);
  });

  it('--services storage is rejected without the storage flag', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'services-storage-gated',
        '--services',
        'storage',
        '--skip-install',
        'services-storage-gated',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('storage');
  });
});

// ─── --auth-methods Flag ──────────────────────────────────────────────────────

describe('rayfin init — --auth-methods flag', () => {
  it('bundled todoapp template enables password and fabric auth by default', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'auth-default',
        '--services',
        'auth,data',
        '--auth-methods',
        'email-password',
        '--skip-install',
        'auth-default',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'auth-default');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const auth = services.auth as Record<string, unknown>;
    expect(auth.enabled).toBe(true);
    // Bundled template uses nested structure: password.enabled, fabric.enabled
    const password = auth.password as Record<string, unknown>;
    expect(password.enabled).toBe(true);
    const fabric = auth.fabric as Record<string, unknown>;
    expect(fabric.enabled).toBe(true);
  });

  it('bundled todoapp template includes allowedRedirectUris', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'auth-redirects',
        '--skip-install',
        'auth-redirects',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'auth-redirects');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const auth = services.auth as Record<string, unknown>;
    const redirectUris = auth.allowedRedirectUris as string[];
    expect(redirectUris).toBeDefined();
    expect(redirectUris.length).toBeGreaterThan(0);
  });
});

// ─── --static-hosting Flag ────────────────────────────────────────────────────

describe('rayfin init — --static-hosting flag', () => {
  it('enables staticHosting block by default when build script exists', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'todoapp',
        '--project-name',
        'static-default',
        '--services',
        'auth,data',
        '--skip-install',
        'static-default',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'static-default');
    const config = readRayfinYml(projectDir);
    const services = config.services as Record<string, unknown>;
    const staticHosting = services.staticHosting as Record<string, unknown>;
    expect(staticHosting).toBeDefined();
    expect(staticHosting.enabled).toBe(true);
    expect(staticHosting.folder).toBe('dist');
    expect(staticHosting.buildCommand).toEqual(expect.any(String));
    expect(staticHosting.indexDocument).toBe('index.html');
  });
});

// ─── --template-name Flag ─────────────────────────────────────────────────────

describe('rayfin init — --template-name flag', () => {
  it('selects correct variant from multi-entry local template', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    // Create a multi-entry template with two variants as subdirectories.
    // Each variant is self-contained with its own rayfin-template.yml.
    const tempDir = join(tmp.dir, 'multi-tpl');
    mkdirSync(tempDir, { recursive: true });

    const rootManifest = {
      apiVersion: 'v1',
      metadata: {
        name: 'multi-entry',
        displayName: 'Multi-Entry Template',
        description: 'Template with multiple entries',
      },
      entries: [
        { name: 'variant-a', path: 'variant-a' },
        { name: 'variant-b', path: 'variant-b' },
      ],
    };
    writeFileSync(
      join(tempDir, 'rayfin-template.yml'),
      stringify(rootManifest)
    );

    // Create variant-a with its own manifest
    mkdirSync(join(tempDir, 'variant-a'), { recursive: true });
    writeFileSync(
      join(tempDir, 'variant-a', 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: { name: 'variant-a', displayName: 'Variant A' },
        entries: [{ name: 'variant-a', path: '.' }],
      })
    );
    writeFileSync(
      join(tempDir, 'variant-a', 'package.json'),
      JSON.stringify(
        { name: '{{projectName}}', version: '1.0.0', scripts: {} },
        null,
        2
      )
    );
    writeFileSync(
      join(tempDir, 'variant-a', 'VARIANT.txt'),
      'This is variant A\n'
    );

    // Create variant-b with its own manifest
    mkdirSync(join(tempDir, 'variant-b'), { recursive: true });
    writeFileSync(
      join(tempDir, 'variant-b', 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: { name: 'variant-b', displayName: 'Variant B' },
        entries: [{ name: 'variant-b', path: '.' }],
      })
    );
    writeFileSync(
      join(tempDir, 'variant-b', 'package.json'),
      JSON.stringify(
        { name: '{{projectName}}', version: '2.0.0', scripts: {} },
        null,
        2
      )
    );
    writeFileSync(
      join(tempDir, 'variant-b', 'VARIANT.txt'),
      'This is variant B\n'
    );

    // Use local path (no git required)
    const result = await runRayfinInit(
      [
        '-t',
        tempDir,
        '--template-name',
        'variant-a',
        '--project-name',
        'multi-test',
        '--skip-install',
        'multi-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode, `init failed:\n${result.output}`).toBe(0);

    const projectDir = join(tmp.dir, 'multi-test');
    expect(existsSync(join(projectDir, 'VARIANT.txt'))).toBe(true);
    const content = readFileSync(join(projectDir, 'VARIANT.txt'), 'utf8');
    expect(content).toContain('variant A');
  });

  it('selects nested variant from grouped local template', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tempDir = join(tmp.dir, 'grouped-tpl');
    createGroupedLocalTemplate(tempDir);

    const result = await runRayfinInit(
      [
        '-t',
        tempDir,
        '--template-name',
        'variant-b',
        '--project-name',
        'grouped-test',
        '--skip-install',
        'grouped-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode, `init failed:\n${result.output}`).toBe(0);

    const projectDir = join(tmp.dir, 'grouped-test');
    expect(existsSync(join(projectDir, 'VARIANT.txt'))).toBe(true);
    const content = readFileSync(join(projectDir, 'VARIANT.txt'), 'utf8');
    expect(content).toContain('variant B');
  });

  it('matches flat local selection output for a grouped nested leaf', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const groupedTemplate = join(tmp.dir, 'grouped-tpl');
    const flatTemplate = join(tmp.dir, 'flat-tpl');
    createGroupedLocalTemplate(groupedTemplate);
    createFlatLocalTemplate(flatTemplate);

    const groupedResult = await runRayfinInit(
      [
        '-t',
        groupedTemplate,
        '--template-name',
        'variant-a',
        '--project-name',
        'parity-test',
        '--skip-install',
        'grouped-output',
      ],
      { cwd: tmp.dir }
    );
    const flatResult = await runRayfinInit(
      [
        '-t',
        flatTemplate,
        '--template-name',
        'variant-a',
        '--project-name',
        'parity-test',
        '--skip-install',
        'flat-output',
      ],
      { cwd: tmp.dir }
    );

    expect(
      groupedResult.exitCode,
      `grouped failed:\n${groupedResult.output}`
    ).toBe(0);
    expect(flatResult.exitCode, `flat failed:\n${flatResult.output}`).toBe(0);

    const groupedDir = join(tmp.dir, 'grouped-output');
    const flatDir = join(tmp.dir, 'flat-output');
    expect(listFiles(groupedDir).sort()).toEqual(listFiles(flatDir).sort());
    expect(readFileSync(join(groupedDir, 'VARIANT.txt'), 'utf8')).toBe(
      readFileSync(join(flatDir, 'VARIANT.txt'), 'utf8')
    );
    expect(readFileSync(join(groupedDir, 'package.json'), 'utf8')).toBe(
      readFileSync(join(flatDir, 'package.json'), 'utf8')
    );
  });

  it('errors with available names when --template-name does not match', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tempDir = join(tmp.dir, 'multi-tpl');
    mkdirSync(tempDir, { recursive: true });

    const manifest = {
      apiVersion: 'v1',
      metadata: {
        name: 'multi-entry',
        displayName: 'Multi-Entry Template',
        description: 'Template with multiple entries',
      },
      entries: [
        { name: 'variant-a', path: 'variant-a' },
        { name: 'variant-b', path: 'variant-b' },
      ],
    };
    writeFileSync(join(tempDir, 'rayfin-template.yml'), stringify(manifest));

    mkdirSync(join(tempDir, 'variant-a'), { recursive: true });
    writeFileSync(
      join(tempDir, 'variant-a', 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: { name: 'variant-a' },
        entries: [{ name: 'variant-a', path: '.' }],
      })
    );
    writeFileSync(
      join(tempDir, 'variant-a', 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }, null, 2)
    );
    mkdirSync(join(tempDir, 'variant-b'), { recursive: true });
    writeFileSync(
      join(tempDir, 'variant-b', 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: { name: 'variant-b' },
        entries: [{ name: 'variant-b', path: '.' }],
      })
    );
    writeFileSync(
      join(tempDir, 'variant-b', 'package.json'),
      JSON.stringify({ name: 'b', version: '1.0.0' }, null, 2)
    );

    const result = await runRayfinInit(
      [
        '-t',
        tempDir,
        '--template-name',
        'nonexistent',
        '--project-name',
        'fail-test',
        '--skip-install',
        'fail-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/variant-a/);
    expect(result.output).toMatch(/variant-b/);
  });

  it('errors with flattened grouped names when --template-name does not match', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tempDir = join(tmp.dir, 'grouped-tpl');
    createGroupedLocalTemplate(tempDir);

    const result = await runRayfinInit(
      [
        '-t',
        tempDir,
        '--template-name',
        'nonexistent',
        '--project-name',
        'grouped-fail-test',
        '--skip-install',
        'grouped-fail-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/Available: variant-a, variant-b/);
  });

  it('errors when multi-entry template has no --template-name in non-interactive mode', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const tempDir = join(tmp.dir, 'multi-tpl');
    mkdirSync(tempDir, { recursive: true });

    const manifest = {
      apiVersion: 'v1',
      metadata: {
        name: 'multi-entry',
        displayName: 'Multi-Entry Template',
        description: 'Template with multiple entries',
      },
      entries: [
        { name: 'variant-a', path: 'variant-a' },
        { name: 'variant-b', path: 'variant-b' },
      ],
    };
    writeFileSync(join(tempDir, 'rayfin-template.yml'), stringify(manifest));

    mkdirSync(join(tempDir, 'variant-a'), { recursive: true });
    writeFileSync(
      join(tempDir, 'variant-a', 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: { name: 'variant-a' },
        entries: [{ name: 'variant-a', path: '.' }],
      })
    );
    writeFileSync(
      join(tempDir, 'variant-a', 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }, null, 2)
    );
    mkdirSync(join(tempDir, 'variant-b'), { recursive: true });
    writeFileSync(
      join(tempDir, 'variant-b', 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: { name: 'variant-b' },
        entries: [{ name: 'variant-b', path: '.' }],
      })
    );
    writeFileSync(
      join(tempDir, 'variant-b', 'package.json'),
      JSON.stringify({ name: 'b', version: '1.0.0' }, null, 2)
    );

    const result = await runRayfinInit(
      [
        '-t',
        tempDir,
        '--project-name',
        'no-name-test',
        '--skip-install',
        'no-name-test',
      ],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/multiple entries/i);
  });
});

// ─── --list-templates JSON ────────────────────────────────────────────────────

describe('rayfin init --list-templates JSON', () => {
  it('returns valid JSON with bundled and registry arrays', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(['--list-templates'], { cwd: tmp.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('schemaVersion');
    expect(parsed).toHaveProperty('bundled');
    expect(parsed).toHaveProperty('registry');
    expect(Array.isArray(parsed.bundled)).toBe(true);
    expect(Array.isArray(parsed.registry)).toBe(true);
  });

  it('bundled entries use source: "built-in" provenance label', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(['-l'], { cwd: tmp.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.bundled.length).toBeGreaterThan(0);
    for (const entry of parsed.bundled) {
      expect(entry.source).toBe('built-in');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('displayName');
    }
  });

  it('does not include synthetic copilot entry in bundled list', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(['--list-templates'], { cwd: tmp.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const names = parsed.bundled.map((b: { name: string }) => b.name);
    expect(names).not.toContain('copilot');
  });

  it('-l short alias matches --list-templates output', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const long = await runRayfinInit(['--list-templates'], { cwd: tmp.dir });
    const short = await runRayfinInit(['-l'], { cwd: tmp.dir });

    expect(long.exitCode).toBe(0);
    expect(short.exitCode).toBe(0);
    expect(JSON.parse(long.stdout)).toEqual(JSON.parse(short.stdout));
  });
});

// ─── Failure Cleanup ──────────────────────────────────────────────────────────

describe('rayfin init — failure cleanup', () => {
  it('cleans up partial output on scaffold failure', async () => {
    const template = createTestTemplate({
      name: 'broken-entry',
    });
    trackCleanup(template.cleanup);

    // Rewrite the manifest to point entry to a non-existent path
    writeFileSync(
      join(template.path, 'rayfin-template.yml'),
      stringify({
        apiVersion: 'v1',
        metadata: {
          name: 'broken-entry',
          displayName: 'Broken',
          description: 'Template with bad entry path',
        },
        entries: [{ name: 'broken-entry', path: 'nonexistent-dir' }],
      })
    );
    template.commitChanges('break entry');

    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      ['-t', template.fileUrl, '--skip-install', 'test-app'],
      { cwd: tmp.dir }
    );

    expect(result.exitCode).not.toBe(0);
    // Partial output directory should be cleaned up
    expect(existsSync(join(tmp.dir, 'test-app'))).toBe(false);
  });
});
