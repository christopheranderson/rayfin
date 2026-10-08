import { describe, it, expect } from 'vitest';

import {
  buildRegistryCloneUrl,
  isFabricTargetingFlagSet,
  isLocalPath,
  planServiceDirectoryScaffolding,
  safeTemplateNameForTelemetry,
  selectTemplateSource,
  validateInitFlags,
  validateWorkspaceFlagSet,
  type RegistryEntryRef,
} from '../init-helpers.js';

describe('isLocalPath', () => {
  // Cases that work identically on Windows and POSIX (string-prefix checks).
  it.each([
    ['.', true],
    ['..', true],
    ['./foo', true],
    ['../foo', true],
    ['.\\foo', true],
    ['..\\foo', true],
    ['/abs/path', true],
    ['foo', false],
    ['some-template', false],
    ['', false],
  ])('%s → %s', (input, expected) => {
    expect(isLocalPath(input)).toBe(expected);
  });

  // path.isAbsolute() is platform-dependent: Windows drive letters only
  // resolve as absolute on Windows; POSIX absolute paths only on POSIX.
  it('classifies Windows drive-letter paths as local on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(isLocalPath('C:\\Users\\me')).toBe(true);
  });

  it('classifies POSIX absolute paths as local on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(isLocalPath('/home/user/template')).toBe(true);
  });

  it('does not classify HTTPS URLs as local', () => {
    expect(isLocalPath('https://github.com/x/y')).toBe(false);
  });

  it('does not classify SSH URLs as local', () => {
    expect(isLocalPath('git@github.com:x/y.git')).toBe(false);
  });
});

describe('validateInitFlags', () => {
  it('returns no errors/warnings for empty input', () => {
    const r = validateInitFlags({});
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.normalizedDialect).toBeUndefined();
  });

  it('flags workspace-uri + workspace-id as mutually exclusive', () => {
    const r = validateInitFlags({
      workspaceUri: 'https://app.fabric.microsoft.com/workspaces/123',
      workspaceId: '123',
    });
    expect(r.errors).toContain(
      '--workspace-uri and --workspace-id are mutually exclusive.'
    );
  });

  it('flags --workspace + --workspace-id as mutually exclusive', () => {
    const r = validateInitFlags({
      workspace: 'My Workspace',
      workspaceId: '123',
    });
    expect(r.errors).toContain(
      '--workspace and --workspace-id are mutually exclusive.'
    );
  });

  it('flags --workspace + --workspace-uri as mutually exclusive', () => {
    const r = validateInitFlags({
      workspace: 'My Workspace',
      workspaceUri: 'https://app.fabric.microsoft.com/workspaces/123',
    });
    expect(r.errors).toContain(
      '--workspace and --workspace-uri are mutually exclusive.'
    );
  });

  it('flags base-api-url + workspace-uri as mutually exclusive', () => {
    const r = validateInitFlags({
      baseApiUrl: 'https://api.fabric.microsoft.com',
      workspaceUri: 'https://app.fabric.microsoft.com/workspaces/123',
    });
    expect(r.errors).toContain(
      '--base-api-url and --workspace-uri are mutually exclusive.'
    );
  });

  it('reports both mutual-exclusion errors when both pairs collide', () => {
    const r = validateInitFlags({
      workspaceUri: 'https://app.fabric.microsoft.com/workspaces/123',
      workspaceId: '123',
      baseApiUrl: 'https://api.fabric.microsoft.com',
    });
    expect(r.errors).toHaveLength(2);
  });

  it('flags --template-name without --template', () => {
    const r = validateInitFlags({ templateName: 'foo' });
    expect(r.errors).toContain(
      '--template-name requires --template <url> pointing to a multi-template source'
    );
  });

  it('accepts --template-name with --template', () => {
    const r = validateInitFlags({
      templateName: 'foo',
      template: 'https://github.com/x/y',
    });
    expect(r.errors).toEqual([]);
  });

  it('does not flag base-api-url + workspace-id (allowed combo)', () => {
    const r = validateInitFlags({
      baseApiUrl: 'https://api.fabric.microsoft.com',
      workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
    });
    expect(r.errors).toEqual([]);
  });

  describe('dialect normalization', () => {
    it('passes through valid mssql lowercase', () => {
      const r = validateInitFlags({ dialect: 'mssql' });
      expect(r.normalizedDialect).toBe('mssql');
      expect(r.warnings).toEqual([]);
    });

    it('passes through valid postgresql lowercase', () => {
      const r = validateInitFlags({ dialect: 'postgresql' });
      expect(r.normalizedDialect).toBe('postgresql');
      expect(r.warnings).toEqual([]);
    });

    it('lowercases uppercase input', () => {
      const r = validateInitFlags({ dialect: 'MSSQL' });
      expect(r.normalizedDialect).toBe('mssql');
      expect(r.warnings).toEqual([]);
    });

    it('lowercases mixed case input', () => {
      const r = validateInitFlags({ dialect: 'PostgreSQL' });
      expect(r.normalizedDialect).toBe('postgresql');
      expect(r.warnings).toEqual([]);
    });

    it('falls back with warnings for invalid dialect', () => {
      const r = validateInitFlags({ dialect: 'cosmos' });
      expect(r.normalizedDialect).toBe('mssql');
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings[0]).toContain("Invalid dialect 'cosmos'");
      expect(r.warnings[1]).toContain('Falling back to default dialect: mssql');
    });

    it('treats empty string as invalid (falls back)', () => {
      const r = validateInitFlags({ dialect: '' });
      expect(r.normalizedDialect).toBe('mssql');
      expect(r.warnings).toHaveLength(2);
    });

    it('leaves dialect undefined when not provided', () => {
      const r = validateInitFlags({});
      expect(r.normalizedDialect).toBeUndefined();
    });
  });
});

describe('validateWorkspaceFlagSet', () => {
  it('returns no errors for empty input', () => {
    expect(validateWorkspaceFlagSet({})).toEqual([]);
  });

  it('accepts a single flag', () => {
    expect(validateWorkspaceFlagSet({ workspace: 'My WS' })).toEqual([]);
    expect(
      validateWorkspaceFlagSet({
        workspaceId: '767f94fa-1106-4377-8fb4-bb931907444a',
      })
    ).toEqual([]);
    expect(
      validateWorkspaceFlagSet({ workspaceUri: 'https://example' })
    ).toEqual([]);
  });

  it('accepts an uppercase workspace GUID', () => {
    expect(
      validateWorkspaceFlagSet({
        workspaceId: '767F94FA-1106-4377-8FB4-BB931907444A',
      })
    ).toEqual([]);
  });

  it.each([
    '',
    'not-a-guid',
    'me',
    '767f94fa110643778fb4bb931907444a',
    'https://app.fabric.microsoft.com/groups/767f94fa-1106-4377-8fb4-bb931907444a/list',
    'https://app.powerbi.com/groups/767f94fa-1106-4377-8fb4-bb931907444a/list',
  ])(
    'rejects invalid workspace ID %j with recovery guidance',
    (workspaceId) => {
      const errors = validateWorkspaceFlagSet({ workspaceId });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('--workspace-id must be a GUID');
      expect(errors[0]).toContain('--workspace-uri <url>');
      expect(validateInitFlags({ workspaceId }).errors).toEqual(errors);
    }
  );

  it('flags workspace + workspace-id', () => {
    expect(
      validateWorkspaceFlagSet({ workspace: 'a', workspaceId: 'b' })
    ).toEqual(['--workspace and --workspace-id are mutually exclusive.']);
  });

  it('flags workspace + workspace-uri', () => {
    expect(
      validateWorkspaceFlagSet({ workspace: 'a', workspaceUri: 'b' })
    ).toEqual(['--workspace and --workspace-uri are mutually exclusive.']);
  });

  it('flags workspace-uri + workspace-id', () => {
    expect(
      validateWorkspaceFlagSet({ workspaceId: 'a', workspaceUri: 'b' })
    ).toEqual(['--workspace-uri and --workspace-id are mutually exclusive.']);
  });

  it('reports all colliding pairs when all three are set', () => {
    const errors = validateWorkspaceFlagSet({
      workspace: 'a',
      workspaceId: 'b',
      workspaceUri: 'c',
    });
    expect(errors).toHaveLength(3);
  });
});

describe('isFabricTargetingFlagSet', () => {
  it('returns false for empty input', () => {
    expect(isFabricTargetingFlagSet({})).toBe(false);
  });

  it.each([
    ['workspace', { workspace: 'My WS' }],
    ['workspaceId', { workspaceId: '00000000-0000-0000-0000-000000000000' }],
    [
      'workspaceUri',
      {
        workspaceUri:
          'https://app.fabric.microsoft.com/groups/00000000-0000-0000-0000-000000000000',
      },
    ],
    ['itemId', { itemId: '11111111-1111-1111-1111-111111111111' }],
    ['baseApiUrl', { baseApiUrl: 'https://api.fabric.microsoft.com' }],
  ])('returns true when %s is set', (_label, opts) => {
    expect(isFabricTargetingFlagSet(opts)).toBe(true);
  });

  it('returns true when multiple Fabric flags are set together', () => {
    expect(
      isFabricTargetingFlagSet({
        workspaceId: '00000000-0000-0000-0000-000000000000',
        itemId: '11111111-1111-1111-1111-111111111111',
        baseApiUrl: 'https://api.fabric.microsoft.com',
      })
    ).toBe(true);
  });

  it('treats empty strings as unset (falsy)', () => {
    expect(
      isFabricTargetingFlagSet({
        workspace: '',
        workspaceId: '',
        workspaceUri: '',
        itemId: '',
        baseApiUrl: '',
      })
    ).toBe(false);
  });

  it('ignores unrelated fields', () => {
    // Adjacent options like --dialect, --non-interactive, --template must NOT
    // be considered Fabric-targeting on their own.
    expect(
      isFabricTargetingFlagSet({
        // @ts-expect-error - test that unrelated fields don't leak into the check
        dialect: 'mssql',
        nonInteractive: true,
        template: 'blank-app',
      })
    ).toBe(false);
  });
});

describe('buildRegistryCloneUrl', () => {
  it('returns url as-is when no ref', () => {
    expect(
      buildRegistryCloneUrl({ name: 'x', url: 'https://github.com/a/b' })
    ).toBe('https://github.com/a/b');
  });

  it('appends #ref when ref is provided', () => {
    expect(
      buildRegistryCloneUrl({
        name: 'x',
        url: 'https://github.com/a/b',
        ref: 'main',
      })
    ).toBe('https://github.com/a/b#main');
  });

  it('preserves existing # in url (does not overwrite)', () => {
    expect(
      buildRegistryCloneUrl({
        name: 'x',
        url: 'https://github.com/a/b#existing-tag',
        ref: 'main',
      })
    ).toBe('https://github.com/a/b#existing-tag');
  });

  it('treats empty ref as no ref', () => {
    expect(
      buildRegistryCloneUrl({
        name: 'x',
        url: 'https://github.com/a/b',
        ref: '',
      })
    ).toBe('https://github.com/a/b');
  });

  it('handles git@ URLs', () => {
    expect(
      buildRegistryCloneUrl({
        name: 'x',
        url: 'git@github.com:a/b.git',
        ref: 'v1.0',
      })
    ).toBe('git@github.com:a/b.git#v1.0');
  });

  it.each([
    ['v0'],
    ['v1'],
    ['v2'],
    ['v10'],
    ['v100'],
    ['v1.0'],
    ['v1.2'],
    ['v1.2.3'],
    ['v1.0.0-rc.1'],
    ['v1.0.0-alpha+build.5'],
    ['1.0.0'],
    ['release-2024-01'],
    ['refs/tags/v1'],
    ['refs/tags/v1.2.3'],
  ])('appends floating-semver ref %s to the registry URL', (ref) => {
    expect(
      buildRegistryCloneUrl({
        name: 'x',
        url: 'https://github.com/org/repo',
        ref,
      })
    ).toBe(`https://github.com/org/repo#${ref}`);
  });
});

describe('selectTemplateSource', () => {
  const noBundled: ReadonlyArray<string> = [];
  const noRegistry: ReadonlyArray<RegistryEntryRef> = [];

  it('returns list-templates when --list-templates is set', () => {
    expect(
      selectTemplateSource({ listTemplates: true }, noBundled, noRegistry)
    ).toEqual({ kind: 'list-templates' });
  });

  it('list-templates wins over other flags', () => {
    expect(
      selectTemplateSource(
        { listTemplates: true, template: 'foo' },
        noBundled,
        noRegistry
      )
    ).toEqual({ kind: 'list-templates' });
  });

  it('returns interactive when no template flag', () => {
    expect(selectTemplateSource({}, noBundled, noRegistry)).toEqual({
      kind: 'interactive',
    });
  });

  it('returns interactive when fromTemplate=true (handled elsewhere)', () => {
    expect(
      selectTemplateSource(
        { template: 'foo', fromTemplate: true },
        noBundled,
        noRegistry
      )
    ).toEqual({ kind: 'interactive' });
  });

  it('returns error when --template-name without --template', () => {
    const r = selectTemplateSource(
      { templateName: 'foo' },
      noBundled,
      noRegistry
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('--template-name requires --template');
    }
  });

  describe('with --template (git URL)', () => {
    it('dispatches HTTPS git URL to external', () => {
      expect(
        selectTemplateSource(
          { template: 'https://github.com/a/b.git' },
          noBundled,
          noRegistry
        )
      ).toEqual({
        kind: 'external',
        url: 'https://github.com/a/b.git',
        templateName: undefined,
      });
    });

    it('dispatches SSH git URL to external', () => {
      expect(
        selectTemplateSource(
          { template: 'git@github.com:a/b.git' },
          noBundled,
          noRegistry
        )
      ).toEqual({
        kind: 'external',
        url: 'git@github.com:a/b.git',
        templateName: undefined,
      });
    });

    it('passes templateName through to external', () => {
      const r = selectTemplateSource(
        {
          template: 'https://github.com/a/b.git',
          templateName: 'pick-me',
        },
        noBundled,
        noRegistry
      );
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/a/b.git',
        templateName: 'pick-me',
      });
    });
  });

  describe('with --template (local path)', () => {
    it('dispatches relative path to local', () => {
      expect(
        selectTemplateSource(
          { template: './my-template' },
          noBundled,
          noRegistry
        )
      ).toEqual({
        kind: 'local',
        path: './my-template',
        templateName: undefined,
      });
    });

    it('dispatches absolute path to local', () => {
      const abs =
        process.platform === 'win32' ? 'C:\\templates\\x' : '/templates/x';
      expect(
        selectTemplateSource({ template: abs }, noBundled, noRegistry)
      ).toEqual({ kind: 'local', path: abs, templateName: undefined });
    });

    it('passes templateName through to local', () => {
      const r = selectTemplateSource(
        { template: './my-template', templateName: 'sub' },
        noBundled,
        noRegistry
      );
      expect(r).toEqual({
        kind: 'local',
        path: './my-template',
        templateName: 'sub',
      });
    });
  });

  describe('with --template (named)', () => {
    it('dispatches bundled name to bundled when known', () => {
      expect(
        selectTemplateSource(
          { template: 'welcome-app' },
          ['welcome-app', 'notes-app'],
          noRegistry
        )
      ).toEqual({ kind: 'bundled', name: 'welcome-app' });
    });

    it('dispatches unknown name to bundled (handler reports error)', () => {
      expect(
        selectTemplateSource(
          { template: 'unknown-name' },
          noBundled,
          noRegistry
        )
      ).toEqual({ kind: 'bundled', name: 'unknown-name' });
    });

    it('prefers registry match over bundled-fallback when name not bundled', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'other-template',
          url: 'https://github.com/community/other-template',
          ref: 'main',
        },
        {
          name: 'community-template',
          url: 'https://github.com/community/template',
          ref: 'main',
        },
      ];
      const r = selectTemplateSource(
        { template: 'community-template' },
        noBundled,
        registry
      );
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/community/template#main',
        registryPath: undefined,
        templateName: undefined,
      });
    });

    it('bundled wins over registry entry of the same name', () => {
      const registry: RegistryEntryRef[] = [
        { name: 'welcome-app', url: 'https://example.com/welcome' },
      ];
      const r = selectTemplateSource(
        { template: 'welcome-app' },
        ['welcome-app'],
        registry
      );
      expect(r).toEqual({ kind: 'bundled', name: 'welcome-app' });
    });

    it('keeps bundled templates ahead of non-first-class default registry entries', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'dataapp',
          url: 'https://github.com/microsoft/fabric-apps-analytic-templates',
          ref: 'main',
          default: true,
        },
      ];
      const r = selectTemplateSource(
        { template: 'dataapp' },
        ['dataapp'],
        registry
      );
      expect(r).toEqual({ kind: 'bundled', name: 'dataapp' });
    });

    it('routes first-class registry entries before bundled templates with fallback', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'dataapp',
          url: 'https://github.com/microsoft/fabric-apps-analytic-templates',
          ref: 'v1',
          templateName: 'Data App',
          default: true,
          firstClass: true,
        },
      ];
      const r = selectTemplateSource(
        { template: 'dataapp' },
        ['dataapp'],
        registry
      );
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/microsoft/fabric-apps-analytic-templates#v1',
        registryPath: undefined,
        templateName: 'Data App',
        fallbackBundledName: 'dataapp',
      });
    });

    it('rejects conflicting template names for first-class registry aliases', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'dataapp',
          url: 'https://github.com/microsoft/fabric-apps-analytic-templates',
          templateName: 'Data App',
          firstClass: true,
        },
      ];
      const r = selectTemplateSource(
        { template: 'dataapp', templateName: 'Other App' },
        ['dataapp'],
        registry
      );
      expect(r).toEqual({
        kind: 'error',
        message:
          "--template-name cannot override first-class template 'dataapp'. This alias is pinned to registry template 'Data App'.",
      });
    });

    it('threads registryPath when registry entry has path', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'mono',
          url: 'https://github.com/org/mono',
          ref: 'v1',
          path: 'apps/web',
        },
      ];
      const r = selectTemplateSource({ template: 'mono' }, noBundled, registry);
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/org/mono#v1',
        registryPath: 'apps/web',
        templateName: undefined,
      });
    });

    it('combines registry path with templateName (path scopes clone, templateName selects manifest entry)', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'mono',
          url: 'https://github.com/org/mono',
          path: 'apps/web',
        },
      ];
      const r = selectTemplateSource(
        { template: 'mono', templateName: 'starter' },
        noBundled,
        registry
      );
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/org/mono',
        registryPath: 'apps/web',
        templateName: 'starter',
      });
    });

    it('preserves templateName when registry entry has no path', () => {
      const registry: RegistryEntryRef[] = [
        { name: 'mono', url: 'https://github.com/org/mono' },
      ];
      const r = selectTemplateSource(
        { template: 'mono', templateName: 'sub-app' },
        noBundled,
        registry
      );
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/org/mono',
        registryPath: undefined,
        templateName: 'sub-app',
      });
    });

    it('uses a registry allow-listed templateName when caller does not provide one', () => {
      const registry: RegistryEntryRef[] = [
        {
          name: 'mono',
          url: 'https://github.com/org/mono',
          templateName: 'starter',
        },
      ];
      const r = selectTemplateSource({ template: 'mono' }, noBundled, registry);
      expect(r).toEqual({
        kind: 'external',
        url: 'https://github.com/org/mono',
        registryPath: undefined,
        templateName: 'starter',
      });
    });
  });

  describe('precedence rules', () => {
    it('git URL beats local path heuristic', () => {
      // SSH-style URL doesn't start with ./ or /, but isGitUrl matches first
      const r = selectTemplateSource(
        { template: 'git@github.com:a/b.git' },
        ['git@github.com:a/b.git'],
        noRegistry
      );
      expect(r.kind).toBe('external');
    });

    it('local path beats bundled-name heuristic when path-like', () => {
      const r = selectTemplateSource(
        { template: './welcome-app' },
        ['welcome-app'],
        noRegistry
      );
      expect(r.kind).toBe('local');
    });
  });
});

describe('safeTemplateNameForTelemetry', () => {
  const bundled = ['todoapp', 'dataapp', 'blankapp', 'gettingstartedauth'];

  it('passes through a real built-in template name', () => {
    expect(safeTemplateNameForTelemetry('todoapp', bundled)).toBe('todoapp');
  });

  it('buckets an unknown --template token to unknown-bundled', () => {
    expect(
      safeTemplateNameForTelemetry('my-companys-internal-codename', bundled)
    ).toBe('unknown-bundled');
  });

  it('buckets when there are no bundled templates', () => {
    expect(safeTemplateNameForTelemetry('todoapp', [])).toBe('unknown-bundled');
  });
});

describe('planServiceDirectoryScaffolding', () => {
  const base = {
    fromTemplate: false,
    functionsDefaultDirExists: false,
  };

  it('scaffolds default rayfin/<service> dirs when no path overrides are set', () => {
    const plan = planServiceDirectoryScaffolding({
      ...base,
      enabledServices: ['auth', 'data', 'storage', 'functions'],
      config: { services: { data: {}, storage: {}, functions: {} } },
    });
    expect(plan).toEqual({
      createDataDir: true,
      createStorageDir: true,
      scaffoldFunctions: true,
    });
  });

  it('skips a service whose block declares an explicit path (multi-package layout)', () => {
    const plan = planServiceDirectoryScaffolding({
      ...base,
      enabledServices: ['data', 'storage', 'functions'],
      config: {
        services: {
          data: { path: 'packages/data' },
          storage: { path: 'packages/storage' },
          functions: { path: 'packages/functions' },
        },
      },
    });
    expect(plan).toEqual({
      createDataDir: false,
      createStorageDir: false,
      scaffoldFunctions: false,
    });
  });

  it('regression: from-template sync with functions.path does not scaffold a stray rayfin/functions app', () => {
    // Mirrors the workspace-todo-app sample: functions live at packages/functions
    // and rayfin/functions does not exist, so the pre-fix code would have laid
    // down a default UDF app. The path override must suppress that.
    const plan = planServiceDirectoryScaffolding({
      enabledServices: ['auth', 'data', 'functions'],
      config: {
        services: {
          data: { path: 'packages/data' },
          functions: { path: 'packages/functions' },
        },
      },
      fromTemplate: true,
      functionsDefaultDirExists: false,
    });
    expect(plan.createDataDir).toBe(false);
    expect(plan.scaffoldFunctions).toBe(false);
  });

  it('does not scaffold functions a second time when the template already shipped rayfin/functions', () => {
    const plan = planServiceDirectoryScaffolding({
      enabledServices: ['functions'],
      config: { services: { functions: {} } },
      fromTemplate: true,
      functionsDefaultDirExists: true,
    });
    expect(plan.scaffoldFunctions).toBe(false);
  });

  it('scaffolds functions when the default dir exists but this is not a from-template sync', () => {
    // Non-sync re-run: existing rayfin/functions should not block a scaffold
    // gated only on fromTemplate.
    const plan = planServiceDirectoryScaffolding({
      enabledServices: ['functions'],
      config: { services: { functions: {} } },
      fromTemplate: false,
      functionsDefaultDirExists: true,
    });
    expect(plan.scaffoldFunctions).toBe(true);
  });

  it('decides each service independently (mixed path overrides)', () => {
    // Only `data` declares a path; storage and functions still get their
    // default dirs. Pins the per-service independence of the three decisions
    // so a future refactor can't accidentally couple them.
    const plan = planServiceDirectoryScaffolding({
      ...base,
      enabledServices: ['data', 'storage', 'functions'],
      config: {
        services: {
          data: { path: 'packages/data' },
          storage: {},
          functions: {},
        },
      },
    });
    expect(plan).toEqual({
      createDataDir: false,
      createStorageDir: true,
      scaffoldFunctions: true,
    });
  });

  it('treats a blank/whitespace-only path as no override', () => {
    // Config validation does not reject a whitespace-only `path`, and a
    // whitespace string is truthy — without trimming it would suppress the
    // default dir while pointing at nothing real.
    const plan = planServiceDirectoryScaffolding({
      ...base,
      enabledServices: ['data', 'storage', 'functions'],
      config: {
        services: {
          data: { path: '   ' },
          storage: { path: '' },
          functions: { path: '\t' },
        },
      },
    });
    expect(plan).toEqual({
      createDataDir: true,
      createStorageDir: true,
      scaffoldFunctions: true,
    });
  });

  it('never scaffolds a service that is not enabled', () => {
    const plan = planServiceDirectoryScaffolding({
      ...base,
      enabledServices: ['auth'],
      config: { services: {} },
    });
    expect(plan).toEqual({
      createDataDir: false,
      createStorageDir: false,
      scaffoldFunctions: false,
    });
  });
});
