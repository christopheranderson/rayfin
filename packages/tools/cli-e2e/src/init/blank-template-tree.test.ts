/**
 * State-change parity assertion for the `init` blankapp template.
 *
 * Asserts the *set of file paths* scaffolded into a fresh project — not
 * the file contents. The intent: catch high-impact regressions like "we
 * stopped scaffolding tsconfig.json" without churning on whitespace,
 * comment style, or YAML key ordering, which the new architecture is
 * expected to clean up.
 *
 * See "State changes are the contract; output is not" in
 * docs/rfc/rayfin-tools-architecture-migration.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  createTempDir,
  listFiles,
  REPO_ROOT,
  runCli,
  runRayfinInit,
  useTrackedCleanup,
} from '../helpers/run-cli.js';

const { track: trackCleanup } = useTrackedCleanup();

const UNIVERSAL_APP_TEMPLATE = join(
  REPO_ROOT,
  'samples',
  'universal-app',
  'template'
);

const CLI_MANAGED_FILES = [
  '.agents/skills/rayfin-connectors/SKILL.md',
  '.agents/skills/rayfin-functions/SKILL.md',
  '.agents/skills/rayfin/SKILL.md',
  '.mcp.json',
  'rayfin/.lockfile.json',
];

/**
 * Patterns that match build artifacts a stale `samples/` copy may have
 * committed (and therefore scaffolded out). These are intentionally
 * excluded from the assertion. The migration's separate state-quality
 * workstreams will address removing them from `samples/`.
 */
const ARTIFACT_PATTERNS: RegExp[] = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)\.temp\//,
  /\.tsbuildinfo$/,
];

function filterArtifacts(files: string[]): string[] {
  return files.filter(
    (file) => !ARTIFACT_PATTERNS.some((pattern) => pattern.test(file))
  );
}

describe('rayfin init — blankapp template tree', () => {
  it('keeps init help identical through both command graphs and listed in root help', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);
    const options = { cwd: tmp.dir, env: { RAYFIN_FEATURE_FLAGS: '' } };
    const [isolated, shortHelp, full, root] = await Promise.all([
      runCli(['init', '--help'], options),
      runCli(['init', '-h'], options),
      runCli(['help', 'init'], options),
      runCli(['-h'], options),
    ]);

    for (const result of [isolated, shortHelp, full, root]) {
      expect(result.exitCode, result.output).toBe(0);
    }
    expect(isolated.stdout).toBe(full.stdout);
    expect(shortHelp.stdout).toBe(full.stdout);
    expect(root.stdout).toMatch(/^\s+init \[options\] \[directory\]/m);
  });

  it.each([
    {
      args: ['--unknown-init-option', 'init'],
      error: /unknown option '--unknown-init-option'/,
    },
    {
      args: ['init', '--unknown-init-option'],
      error: /unknown option '--unknown-init-option'/,
    },
    {
      args: ['--output', 'init'],
      error: /argument 'init'.*invalid/,
    },
    {
      args: ['--output=init'],
      error: /argument 'init'.*invalid/,
    },
    { args: ['--output'], error: /argument missing/ },
    { args: ['init', '--output'], error: /argument missing/ },
    {
      args: ['not-a-command', 'init'],
      error: /unknown command 'not-a-command'/,
    },
  ])('rejects invalid routing arguments: $args', async ({ args, error }) => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);
    const result = await runCli(args, {
      cwd: tmp.dir,
      env: { RAYFIN_FEATURE_FLAGS: '' },
    });
    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toMatch(error);
    expect(existsSync(join(tmp.dir, 'rayfin'))).toBe(false);
  });

  it.each([['--yes'], ['--json'], ['--output', 'json'], ['--output=plain']])(
    'preserves leading root options for independent init: %j',
    async (...leading) => {
      const tmp = createTempDir();
      trackCleanup(tmp.cleanup);
      mkdirSync(join(tmp.dir, 'rayfin'));
      writeFileSync(
        join(tmp.dir, 'rayfin', 'rayfin.yml'),
        'id: parent\nservices:\n  data:\n    connectionString: ${RAYFIN_TEST_UNRESOLVED_PARENT_DATABASE}\n'
      );
      const result = await runCli(
        [
          ...leading,
          'init',
          'child',
          '--template',
          'blankapp',
          '--project-name',
          'child',
          '--yes',
          '--skip-install',
        ],
        { cwd: tmp.dir, env: { RAYFIN_FEATURE_FLAGS: '' } }
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(
        existsSync(join(tmp.dir, 'child', 'packages', 'frontend', 'index.html'))
      ).toBe(true);
    }
  );

  it.each([false, true])(
    'scaffolds independently of unresolved parent settings (feature=%s)',
    async (enabled) => {
      const tmp = createTempDir();
      trackCleanup(tmp.cleanup);
      mkdirSync(join(tmp.dir, 'rayfin'));
      writeFileSync(
        join(tmp.dir, 'rayfin', 'rayfin.yml'),
        'id: parent\nservices:\n  data:\n    enabled: true\n    connectionString: ${RAYFIN_TEST_UNRESOLVED_PARENT_DATABASE}\n'
      );
      const result = await runRayfinInit(
        [
          'child',
          '--template',
          'blankapp',
          '--project-name',
          'child',
          '--yes',
          '--skip-install',
        ],
        { cwd: tmp.dir, env: { RAYFIN_FEATURE_FLAGS: enabled ? 'finley' : '' } }
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(
        existsSync(
          join(tmp.dir, 'child', 'packages', 'frontend', 'src', 'Finley.tsx')
        )
      ).toBe(enabled);
      expect(
        readFileSync(join(tmp.dir, 'rayfin', 'rayfin.yml'), 'utf8')
      ).toContain('${RAYFIN_TEST_UNRESOLVED_PARENT_DATABASE}');
    }
  );

  it.each(['blankapp', 'universal-app', UNIVERSAL_APP_TEMPLATE])(
    'opts only the mascot into %s using the CLI feature flag',
    async (template) => {
      for (const enabled of [false, true]) {
        const tmp = createTempDir();
        trackCleanup(tmp.cleanup);
        const result = await runRayfinInit(
          [
            '--template',
            template,
            '--project-name',
            'welcome-flags',
            '--skip-install',
            'welcome-flags',
          ],
          {
            cwd: tmp.dir,
            env: { RAYFIN_FEATURE_FLAGS: enabled ? 'finley' : '' },
          }
        );
        expect(result.exitCode, result.output).toBe(0);
        const frontend = join(
          tmp.dir,
          'welcome-flags',
          'packages',
          'frontend',
          'src'
        );
        expect(existsSync(join(frontend, 'Welcome.tsx'))).toBe(true);
        expect(existsSync(join(frontend, 'Welcome.activity.ts'))).toBe(true);
        expect(
          existsSync(
            join(frontend, '..', 'scripts', 'source-activity-plugin.mjs')
          )
        ).toBe(false);
        expect(
          existsSync(join(frontend, '..', 'scripts', 'source-activity.mjs'))
        ).toBe(false);
        expect(
          readFileSync(join(frontend, '..', 'vite.config.ts'), 'utf8')
        ).toMatch(
          /rayfinLocalDev\(\{\s*autoLogin: true,\s*sourceActivity: true\s*\}\)/
        );
        for (const file of ['Finley.tsx', 'Finley.css', 'Finley.spec.tsx']) {
          expect(existsSync(join(frontend, file))).toBe(enabled);
        }
        expect(
          readFileSync(
            join(frontend, 'EmptyStatePreview.tsx'),
            'utf8'
          ).includes("from './Finley'")
        ).toBe(enabled);
        expect(existsSync(join(frontend, 'welcome-features.json'))).toBe(false);
        const project = join(tmp.dir, 'welcome-flags');
        expect(existsSync(join(project, '.template-features'))).toBe(false);
        expect(
          JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
            .template.features
        ).toBeUndefined();
        expect(readFileSync(join(project, 'README.md'), 'utf8')).not.toContain(
          'RAYFIN_FEATURE_FLAGS'
        );
        expect(
          existsSync(join(frontend, 'components', 'auth-gate.component.tsx'))
        ).toBe(true);
      }
    }
  );

  it('scaffolds the canonical set of files (no artifact churn)', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'blankapp',
        '--project-name',
        'blank-tree-test',
        '--skip-install',
        'blank-tree-test',
      ],
      { cwd: tmp.dir }
    );
    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'blank-tree-test');
    expect(existsSync(projectDir)).toBe(true);

    const actual = filterArtifacts(listFiles(projectDir)).sort();
    const expected = [
      ...filterArtifacts(listFiles(UNIVERSAL_APP_TEMPLATE)).filter(
        (path) => !path.startsWith('.template-features/')
      ),
      ...CLI_MANAGED_FILES,
    ].sort();

    expect(actual).toEqual(expected);

    const manifest = JSON.parse(
      readFileSync(join(projectDir, 'package.json'), 'utf8')
    ) as {
      template?: { name?: string };
      workspaces?: string[];
    };
    expect(manifest.template?.name).toBe('universal-app');
    expect(manifest.workspaces).toEqual(['packages/*']);
  });

  // These files are unique to the Universal App. Their absence means another
  // template shadowed the CLI alias during discovery or bundling.
  it('resolves blankapp to the Universal App, not a shadowing template', async () => {
    const tmp = createTempDir();
    trackCleanup(tmp.cleanup);

    const result = await runRayfinInit(
      [
        '--template',
        'blankapp',
        '--project-name',
        'blank-identity-test',
        '--skip-install',
        'blank-identity-test',
      ],
      { cwd: tmp.dir }
    );
    expect(result.exitCode).toBe(0);

    const projectDir = join(tmp.dir, 'blank-identity-test');
    expect(existsSync(join(projectDir, 'scripts', 'scaffold.mjs'))).toBe(true);
    expect(
      existsSync(
        join(projectDir, '.agents', 'skills', 'capability-router', 'SKILL.md')
      )
    ).toBe(true);
  });
});
