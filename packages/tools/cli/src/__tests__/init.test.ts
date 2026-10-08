import { randomUUID } from 'crypto';
import {
  constants,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { mkdir, writeFile, rm, access, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { Command } from 'commander';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse } from 'yaml';

vi.mock('../utils/catalog-navigator.js', () => ({
  navigateCatalog: vi.fn(),
}));

import {
  init,
  createRayfinYml,
  applyRayfinYmlIdentityEdits,
  isDataServiceEnabled,
  isLocalPath,
  registrySourceLabel,
} from '../commands/init';
import { CliHandledError } from '../errors';
import { navigateCatalog } from '../utils/catalog-navigator.js';
import { selectTemplateEntry } from '../utils/template-entry-selector.js';
import { discoverBundledTemplates } from '../utils/template-scaffold.js';

// We'll focus on testing the command structure and helper functions rather than full integration
describe('init command', () => {
  let initCommand: Command;

  beforeEach(() => {
    initCommand = init();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct command name and description', () => {
    expect(initCommand.name()).toBe('init');
    expect(initCommand.description()).toBe('Create a new Rayfin project');
  });

  it('should have an optional directory argument with no default', () => {
    const args = initCommand.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].name()).toBe('directory');
    expect(args[0].required).toBe(false);
    // No Commander default: omission must be distinguishable from an explicit
    // `.` so the create-project gate can decide nest-vs-in-place. The action
    // normalizes an omitted (undefined) directory to '.' itself.
    expect(args[0].defaultValue).toBeUndefined();
  });

  it('should have --workspace-id and --item-id options', () => {
    const workspaceIdOption = initCommand.options.find(
      (o) => o.long === '--workspace-id'
    );
    const itemIdOption = initCommand.options.find(
      (o) => o.long === '--item-id'
    );

    expect(workspaceIdOption).toBeDefined();
    expect(workspaceIdOption?.description).toBe(
      'Provide a Fabric workspace ID. You cannot use both --workspace and --workspace-id together'
    );
    expect(itemIdOption).toBeDefined();
    expect(itemIdOption?.description).toBe('Provide a Fabric App Item ID');
  });

  it('should have --workspace option', () => {
    const opts = initCommand.options.map((o) => o.long);
    expect(opts).toContain('--workspace');
    const option = initCommand.options.find((o) => o.long === '--workspace');
    expect(option?.description).toBe(
      'Enter a valid Fabric workspace name. Check in Fabric portal if unsure'
    );
    expect(option?.short).toBe('-w');
  });

  it('should hide --base-api-url in default production help', () => {
    const savedApiUrl = process.env.RAYFIN_FABRIC_API_URL;
    delete process.env.RAYFIN_FABRIC_API_URL;

    try {
      const command = init();
      const option = command.options.find((o) => o.long === '--base-api-url');
      expect(option).toBeDefined();
      expect(option?.hidden).toBe(true);
    } finally {
      if (savedApiUrl === undefined) {
        delete process.env.RAYFIN_FABRIC_API_URL;
      } else {
        process.env.RAYFIN_FABRIC_API_URL = savedApiUrl;
      }
    }
  });

  it('should keep internal environment flags registered but hidden from help', () => {
    const workspaceUriOption = initCommand.options.find(
      (o) => o.long === '--workspace-uri'
    );
    const baseApiUrlOption = initCommand.options.find(
      (o) => o.long === '--base-api-url'
    );
    const help = initCommand.helpInformation();

    expect(workspaceUriOption).toBeDefined();
    expect(workspaceUriOption?.description).toMatch(/portal workspace URL/i);
    expect(workspaceUriOption?.hidden).toBe(true);
    expect(baseApiUrlOption).toBeDefined();
    expect(baseApiUrlOption?.hidden).toBe(true);
    expect(help).not.toContain('--workspace-uri');
    expect(help).not.toContain('--base-api-url');
  });

  it('should have --template and --list-templates options', () => {
    const opts = initCommand.options.map((o) => o.long);
    expect(opts).toContain('--template');
    expect(opts).toContain('--list-templates');
  });

  it('should describe refreshed init flag help text', () => {
    const optionDescriptions = Object.fromEntries(
      initCommand.options.map((option) => [option.long, option.description])
    );

    expect(optionDescriptions['--project-name']).toBe(
      'Override the project name and update rayfin.yml without changing the directory.'
    );
    expect(optionDescriptions['--template-name']).toBe(
      'Pick one template from a multi-template source non-interactively'
    );
    expect(optionDescriptions['--static-hosting']).toBe(
      'Scaffold a static frontend; enabled by default'
    );
  });

  it('should have -t as short alias for --template', () => {
    const templateOpt = initCommand.options.find(
      (o) => o.long === '--template'
    );
    expect(templateOpt).toBeDefined();
    expect(templateOpt!.short).toBe('-t');
  });

  it('should have -l as short alias for --list-templates', () => {
    const listOpt = initCommand.options.find(
      (o) => o.long === '--list-templates'
    );
    expect(listOpt).toBeDefined();
    expect(listOpt!.short).toBe('-l');
  });
});

// Test the helper functions directly
describe('init helper functions', () => {
  describe('createRayfinYml', () => {
    it('should generate rayfin.yml with correct structure', () => {
      const content = createRayfinYml('Test Project', ['auth', 'data']);
      expect(content).toContain('id: test-project');
      expect(content).toContain('name: Test Project');
      expect(content).toContain('version: 1.0.11');
      expect(content).toContain('services:');
      expect(content).toContain('auth:');
      expect(content).toContain('data:');
      expect(content).toContain('enabled: true');
    });

    it('should handle partial service selection', () => {
      const content = createRayfinYml('Test Project', ['auth']);
      expect(content).toContain('auth:');
      expect(content).toContain('data:');
      // Should have auth enabled and data disabled
      const lines = content.split('\n');
      const authIndex = lines.findIndex((line) => line.includes('auth:'));
      const dataIndex = lines.findIndex((line) => line.includes('data:'));
      expect(lines[authIndex + 1]).toContain('enabled: true');
      expect(lines[dataIndex + 1]).toContain('enabled: false');
    });

    it('should create slug from project name with special characters', () => {
      const content = createRayfinYml('My Cool Project!!!', ['data']);
      expect(content).toContain('id: my-cool-project');
      expect(content).toContain('name: My Cool Project!!!');
    });

    it('should populate auth settings when auth service is enabled', () => {
      const content = createRayfinYml('Test Project', ['auth']);
      const config = parse(content);

      // Auth should be enabled
      expect(config.services.auth.enabled).toBe(true);

      // Custom claims should be populated
      expect(config.services.auth.customClaims).toBeDefined();
      expect(config.services.auth.customClaims.app_version).toBe('1.0.0');

      // Scopes should be populated
      expect(config.services.auth.scopes).toBeDefined();
      expect(config.services.auth.scopes).toContain('read:data');
      expect(config.services.auth.scopes).toContain('write:data');

      // Hidden settings should NOT be present (managed internally)
      expect(config.services.auth.issuer).toBeUndefined();
      expect(config.services.auth.audience).toBeUndefined();
      expect(config.services.auth.expiryInMinutes).toBeUndefined();
      expect(config.services.auth.validateLifetime).toBeUndefined();
      expect(config.services.auth.validateIssuer).toBeUndefined();
      expect(config.services.auth.validateAudience).toBeUndefined();
      expect(config.services.auth.clockSkew).toBeUndefined();
    });

    it('should not populate auth settings when auth service is disabled', () => {
      const content = createRayfinYml('Test Project', ['data']);
      const config = parse(content);

      // Auth should be disabled
      expect(config.services.auth.enabled).toBe(false);

      // Auth settings should not be present
      expect(config.services.auth.customClaims).toBeUndefined();
      expect(config.services.auth.scopes).toBeUndefined();
    });

    it('rejects storage when data is not selected', () => {
      expect(() => createRayfinYml('Test Project', ['storage'])).toThrow(
        'Storage requires the Data service.'
      );
    });

    it('enables storage when data is explicitly selected', () => {
      const content = createRayfinYml('Test Project', ['data', 'storage']);
      const config = parse(content);

      expect(config.services.data.enabled).toBe(true);
      expect(config.services.storage.enabled).toBe(true);
    });

    it('should populate email settings with correct SMTP host when email is enabled', () => {
      const content = createRayfinYml('Test Project', ['auth'], true);
      const config = parse(content);

      // Auth should be enabled
      expect(config.services.auth.enabled).toBe(true);

      // Email configuration should be present
      expect(config.services.auth.email).toBeDefined();
      expect(config.services.auth.email.enabled).toBe(true);
      expect(config.services.auth.email.provider).toBe('smtp');
      expect(config.services.auth.email.senderName).toBe('Rayfin Platform');
      expect(config.services.auth.email.verificationTokenExpirationHours).toBe(
        24
      );
      expect(
        config.services.auth.email.passwordResetTokenExpirationMinutes
      ).toBe(30);

      // SMTP configuration should use 'maildev' hostname for Docker network
      expect(config.services.auth.email.smtp).toBeDefined();
      expect(config.services.auth.email.smtp.host).toBe('maildev');
      expect(config.services.auth.email.smtp.port).toBe(1025);
      expect(config.services.auth.email.smtp.senderEmail).toBe(
        'noreply@rayfin.local'
      );
      expect(config.services.auth.email.smtp.username).toBe('');
      expect(config.services.auth.email.smtp.password).toBe('');
      expect(config.services.auth.email.smtp.useSsl).toBe(false);
      expect(config.services.auth.email.smtp.useStartTls).toBe(false);
      expect(config.services.auth.email.smtp.webPort).toBe(1080);
    });

    it('should not include email settings when email is disabled', () => {
      const content = createRayfinYml('Test Project', ['auth'], false);
      const config = parse(content);

      // Auth should be enabled but email should not be present
      expect(config.services.auth.enabled).toBe(true);
      expect(config.services.auth.email).toBeUndefined();
    });

    it('should include fabric config when fabric auth method is selected', () => {
      const content = createRayfinYml(
        'Test Project',
        ['auth'],
        false,
        undefined,
        {
          passwordEnabled: true,
          fabricEnabled: true,
        }
      );
      const config = parse(content);

      expect(config.services.auth.enabled).toBe(true);
      expect(config.services.auth.fabric).toBeDefined();
      expect(config.services.auth.fabric.enabled).toBe(true);
    });

    it('should not include fabric config when fabric is not selected', () => {
      const content = createRayfinYml(
        'Test Project',
        ['auth'],
        false,
        undefined,
        {
          passwordEnabled: true,
        }
      );
      const config = parse(content);

      expect(config.services.auth.enabled).toBe(true);
      expect(config.services.auth.fabric).toBeUndefined();
    });

    it('should not auto-enable email when only fabric is selected', () => {
      const content = createRayfinYml(
        'Test Project',
        ['auth'],
        false,
        undefined,
        {
          passwordEnabled: false,
          fabricEnabled: true,
        }
      );
      const config = parse(content);

      expect(config.services.auth.fabric).toEqual({ enabled: true });
      expect(config.services.auth.email).toBeUndefined();
    });

    it('should include staticHosting config when provided', () => {
      const content = createRayfinYml(
        'Test Project',
        ['auth', 'data'],
        false,
        undefined,
        undefined,
        {
          enabled: true,
          root: './frontend',
          folder: 'dist',
          buildCommand: 'npm run build',
          indexDocument: 'index.html',
        }
      );
      const config = parse(content);

      expect(config.services.staticHosting).toBeDefined();
      expect(config.services.staticHosting.enabled).toBe(true);
      expect(config.services.staticHosting.root).toBe('./frontend');
      expect(config.services.staticHosting.folder).toBe('dist');
      expect(config.services.staticHosting.buildCommand).toBe('npm run build');
      expect(config.services.staticHosting.indexDocument).toBe('index.html');
    });

    it('should default staticHosting to disabled when not provided', () => {
      const content = createRayfinYml('Test Project', ['auth']);
      const config = parse(content);

      expect(config.services.staticHosting).toBeDefined();
      expect(config.services.staticHosting.enabled).toBe(false);
      expect(config.services.staticHosting.folder).toBe('dist');
    });

    it('scaffolds new apps with protected asset access', () => {
      const content = createRayfinYml('Test Project', ['auth']);
      const config = parse(content);

      expect(config.services.staticHosting.assetAccess).toBe('protected');
    });

    it('scaffolds an enabled static-hosting block with protected asset access', () => {
      const content = createRayfinYml(
        'Test Project',
        ['auth'],
        false,
        undefined,
        undefined,
        { enabled: true, folder: 'dist' }
      );
      const config = parse(content);

      expect(config.services.staticHosting.assetAccess).toBe('protected');
    });

    it('should include staticHosting with enabled=false when declined', () => {
      const content = createRayfinYml(
        'Test Project',
        ['auth'],
        false,
        undefined,
        undefined,
        { enabled: false, folder: 'dist' }
      );
      const config = parse(content);

      expect(config.services.staticHosting).toBeDefined();
      expect(config.services.staticHosting.enabled).toBe(false);
      expect(config.services.staticHosting.folder).toBe('dist');
    });

    it('should omit optional root when set to default "."', () => {
      const content = createRayfinYml(
        'Test Project',
        ['data'],
        false,
        undefined,
        undefined,
        { enabled: true, folder: './dist' }
      );
      const config = parse(content);

      expect(config.services.staticHosting).toBeDefined();
      expect(config.services.staticHosting.enabled).toBe(true);
      expect(config.services.staticHosting.root).toBeUndefined();
      expect(config.services.staticHosting.folder).toBe('./dist');
    });

    it('omits the functions block entirely when functions is not in services', () => {
      // The disabled-placeholder `functions: { enabled: false }` block
      // was just noise in scaffolded rayfin.yml. The from-scratch writer
      // therefore stops emitting that placeholder when the user hasn't
      // opted in. Absence is semantically equivalent to
      // `enabled: false`.
      const content = createRayfinYml('Test Project', ['auth', 'data']);
      const config = parse(content);
      expect(config.services.functions).toBeUndefined();
    });

    it('emits a functions block only when functions is selected', () => {
      const content = createRayfinYml('Test Project', [
        'auth',
        'data',
        'functions',
      ]);
      const config = parse(content);
      expect(config.services.functions).toEqual({
        enabled: true,
        auth: { type: 'application' },
      });
    });

    it('omits the storage block entirely when storage is not in services', () => {
      // Mirrors the functions behavior: the disabled-placeholder
      // `storage: { enabled: false }` block was just noise in
      // scaffolded rayfin.yml. The from-scratch writer therefore stops
      // emitting that placeholder when the user hasn't opted in.
      // Absence is semantically equivalent to `enabled: false`.
      const content = createRayfinYml('Test Project', ['auth', 'data']);
      const config = parse(content);
      expect(config.services.storage).toBeUndefined();
    });

    it('emits a storage block only when storage is selected', () => {
      const content = createRayfinYml('Test Project', [
        'auth',
        'data',
        'storage',
      ]);
      const config = parse(content);
      expect(config.services.storage).toEqual({ enabled: true });
    });
  });

  describe('applyRayfinYmlIdentityEdits', () => {
    // The strict RayfinConfig interface marks many properties required that
    // real templates omit; cast through `unknown` so these tests can use the
    // realistic minimal shapes external templates actually ship.
    const baseConfig = {
      apiVersion: 'rayfin.microsoft.com/v0',
      version: '1.0.0',
      name: 'Template Original',
      id: 'template-original',
      services: {
        auth: { enabled: true },
        data: { enabled: true, dialect: 'mssql' as const },
      },
    } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];

    it('returns null when nothing needs to change (idempotent no-op)', () => {
      const result = applyRayfinYmlIdentityEdits(
        baseConfig,
        (baseConfig as { name: string }).name,
        undefined
      );
      expect(result).toBeNull();
    });

    it.each([
      '',
      'services: {}\n',
      'services:\n  functions:\n    enabled: false\n    path: packages/functions\n    buildCommand: custom-build\n',
    ])(
      'authors application auth when selecting functions in %j',
      (services) => {
        const existingConfig = parse('id: example\nname: example\n' + services);
        const before = structuredClone(existingConfig);

        const result = applyRayfinYmlIdentityEdits(
          existingConfig,
          'example',
          undefined,
          ['functions']
        );

        expect(parse(result!).services.functions).toEqual({
          ...before.services?.functions,
          enabled: true,
          auth: { type: 'application' },
        });
        expect(existingConfig).toEqual(before);
      }
    );

    it('preserves valid authored application settings while enabling functions', () => {
      const existingConfig = parse(
        'id: example\nname: example\nservices:\n  functions:\n' +
          '    enabled: false\n    path: apps/functions\n' +
          '    auth: { type: application, custom: preserved }\n'
      );

      const result = applyRayfinYmlIdentityEdits(
        existingConfig,
        'example',
        undefined,
        ['functions']
      );

      expect(parse(result!).services.functions).toEqual({
        ...existingConfig.services.functions,
        enabled: true,
      });
      expect(existingConfig.services.functions.enabled).toBe(false);
    });

    it.each(['', '    auth: { type: application }\n'])(
      'leaves already-enabled functions unchanged on a no-op re-run (%j)',
      (auth) => {
        const existingConfig = parse(
          'id: example\nname: example\nservices:\n  functions:\n    enabled: true\n' +
            auth
        );

        expect(
          applyRayfinYmlIdentityEdits(existingConfig, 'example', undefined, [
            'functions',
          ])
        ).toBeNull();
        const renamed = applyRayfinYmlIdentityEdits(
          existingConfig,
          'renamed',
          undefined,
          ['functions']
        );
        expect(parse(renamed!).services.functions).toEqual(
          existingConfig.services.functions
        );
      }
    );

    it.each(
      [
        '{ type: delegated }',
        '{ type: Application }',
        '{}',
        'null',
        '[]',
        'application',
      ].flatMap((auth) => [true, false].map((enabled) => ({ auth, enabled })))
    )(
      'rejects explicit auth=$auth with enabled=$enabled without mutation',
      ({ auth, enabled }) => {
        const existingConfig = parse(
          'id: example\nname: example\nservices:\n  functions:\n' +
            `    enabled: ${enabled}\n    auth: ${auth}\n`
        );
        const before = structuredClone(existingConfig);

        expect(() =>
          applyRayfinYmlIdentityEdits(existingConfig, 'example', undefined, [
            'functions',
          ])
        ).toThrow('Set services.functions.auth.type to "application".');
        expect(existingConfig).toEqual(before);
      }
    );

    it.each(['false', 'application', '[]'])(
      'rejects a malformed functions block (%s) rather than replacing it',
      (functions) => {
        const existingConfig = parse(
          `id: example\nname: example\nservices:\n  functions: ${functions}\n`
        );
        expect(() =>
          applyRayfinYmlIdentityEdits(existingConfig, 'example', undefined, [
            'functions',
          ])
        ).toThrow('Invalid services.functions: expected a mapping');
      }
    );

    it('renames name + id when projectName differs', () => {
      const result = applyRayfinYmlIdentityEdits(
        baseConfig,
        'My Renamed App',
        undefined
      );
      expect(result).not.toBeNull();
      const parsed = parse(result!);
      expect(parsed.name).toBe('My Renamed App');
      expect(parsed.id).toBe('my-renamed-app');
      // Auth/data blocks preserved exactly as authored.
      expect(parsed.services.auth).toEqual({ enabled: true });
      expect(parsed.services.data).toEqual({
        enabled: true,
        dialect: 'mssql',
      });
    });

    it('updates services.data.dialect when --dialect supplied', () => {
      const result = applyRayfinYmlIdentityEdits(
        baseConfig,
        (baseConfig as { name: string }).name,
        'postgresql'
      );
      expect(result).not.toBeNull();
      const parsed = parse(result!);
      expect(parsed.services.data.dialect).toBe('postgresql');
      // Other fields untouched.
      expect(parsed.name).toBe('Template Original');
    });

    it('adds explicitly selected services without disabling template defaults', () => {
      const configWithSettings = {
        ...baseConfig,
        services: {
          auth: { enabled: true, fabric: { enabled: true } },
          data: { enabled: true, dialect: 'mssql' as const },
          staticHosting: { enabled: true, folder: 'dist' },
        },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];

      const result = applyRayfinYmlIdentityEdits(
        configWithSettings,
        'Template Original',
        undefined,
        ['data', 'storage']
      );

      const parsed = parse(result!);
      expect(parsed.services.auth).toEqual({
        enabled: true,
        fabric: { enabled: true },
      });
      expect(parsed.services.data).toEqual({
        enabled: true,
        dialect: 'mssql',
      });
      expect(parsed.services.storage).toEqual({ enabled: true });
      expect(parsed.services.staticHosting).toEqual({
        enabled: true,
        folder: 'dist',
      });
    });

    it('does not inject a dialect when services.data is missing entirely', () => {
      // Regression guard for the missing-data-block trap: a template
      // author who omitted `services.data` entirely must not have a
      // dialect silently injected. The helper should return null when
      // only --dialect would have changed.
      const noDataConfig = {
        ...baseConfig,
        services: { auth: { enabled: true } },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];
      const result = applyRayfinYmlIdentityEdits(
        noDataConfig,
        (noDataConfig as { name: string }).name,
        'postgresql'
      );
      expect(result).toBeNull();
    });

    it('does not touch services.auth shape when applying identity edits', () => {
      // Bug 2 regression guard: the previous helper rebuilt the auth block
      // from defaults whenever the project name changed. The new helper
      // must leave the template author's minimal auth block alone.
      const minimalAuth = {
        ...baseConfig,
        services: { auth: { enabled: true } },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];
      const result = applyRayfinYmlIdentityEdits(
        minimalAuth,
        'New Name',
        undefined
      );
      const parsed = parse(result!);
      expect(parsed.services.auth).toEqual({ enabled: true });
      expect(parsed.services.auth.customClaims).toBeUndefined();
      expect(parsed.services.auth.scopes).toBeUndefined();
      expect(parsed.services.auth.password).toBeUndefined();
      expect(parsed.services.auth.allowedRedirectUris).toBeUndefined();
      expect(parsed.services.staticHosting).toBeUndefined();
      expect(parsed.services.functions).toBeUndefined();
    });

    it('preserves arbitrary custom top-level keys the template author set', () => {
      const customConfig = {
        ...baseConfig,
        // Template authors can set arbitrary keys; the helper must not
        // strip them.
        customField: 'preserved',
        nested: { keep: 'me' },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];
      const result = applyRayfinYmlIdentityEdits(
        customConfig,
        'Renamed',
        undefined
      );
      const parsed = parse(result!);
      expect(parsed.customField).toBe('preserved');
      expect(parsed.nested).toEqual({ keep: 'me' });
    });

    it('combines name/id rename and dialect edits in a single write', () => {
      const config = {
        ...baseConfig,
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];
      const result = applyRayfinYmlIdentityEdits(
        config,
        'Combined Project',
        'postgresql'
      );
      const parsed = parse(result!);
      expect(parsed.name).toBe('Combined Project');
      expect(parsed.id).toBe('combined-project');
      expect(parsed.services.data.dialect).toBe('postgresql');
    });

    it('updates the dialect in place when services.data exists but enabled is false', () => {
      // Regression guard for the stale-dialect trap: a template author
      // who shipped `data: { enabled: false, dialect: postgresql }` and
      // a user who scaffolds with `--dialect mssql` get the dialect
      // updated so a later flip of `enabled: true` doesn't inherit the
      // stale postgresql value (which would, for example, fail at
      // publish time against a Fabric backend that doesn't support it).
      // The `enabled` flag stays untouched — only the dialect moves.
      const disabledData = {
        ...baseConfig,
        services: {
          auth: { enabled: true },
          data: { enabled: false, dialect: 'mssql' as const },
        },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];
      const result = applyRayfinYmlIdentityEdits(
        disabledData,
        (disabledData as { name: string }).name,
        'postgresql'
      );
      expect(result).not.toBeNull();
      const parsed = parse(result as string) as {
        services: { data: { enabled: boolean; dialect: string } };
      };
      expect(parsed.services.data.enabled).toBe(false);
      expect(parsed.services.data.dialect).toBe('postgresql');
    });

    it('enables requested auth and data without changing other services', () => {
      const disabledCoreServices = {
        ...baseConfig,
        services: {
          auth: { enabled: false, fabric: { enabled: true } },
          data: { enabled: false, dialect: 'mssql' as const },
          storage: { enabled: true, custom: 'preserved' },
        },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];

      const result = applyRayfinYmlIdentityEdits(
        disabledCoreServices,
        (disabledCoreServices as { name: string }).name,
        undefined,
        ['auth', 'data']
      );

      const parsed = parse(result!);
      expect(parsed.services.auth).toEqual({
        enabled: true,
        fabric: { enabled: true },
      });
      expect(parsed.services.data).toEqual({
        enabled: true,
        dialect: 'mssql',
      });
      expect(parsed.services.storage).toEqual({
        enabled: true,
        custom: 'preserved',
      });
    });

    it('enables a requested optional service without replacing its settings', () => {
      const disabledStorage = {
        ...baseConfig,
        services: {
          auth: { enabled: true },
          data: { enabled: true, dialect: 'mssql' as const },
          storage: { enabled: false, custom: 'preserved' },
        },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];

      const result = applyRayfinYmlIdentityEdits(
        disabledStorage,
        (disabledStorage as { name: string }).name,
        undefined,
        ['storage']
      );

      const parsed = parse(result!);
      expect(parsed.services.storage).toEqual({
        enabled: true,
        custom: 'preserved',
      });
      expect(parsed.services.auth.enabled).toBe(true);
      expect(parsed.services.data.enabled).toBe(true);
    });

    it('rejects enabling storage when a template keeps data disabled', () => {
      const disabledData = {
        ...baseConfig,
        services: {
          ...baseConfig.services,
          data: { enabled: false, dialect: 'mssql' as const },
          storage: { enabled: false },
        },
      } as unknown as Parameters<typeof applyRayfinYmlIdentityEdits>[0];

      expect(() =>
        applyRayfinYmlIdentityEdits(
          disabledData,
          (disabledData as { name: string }).name,
          undefined,
          ['storage']
        )
      ).toThrow('Storage requires the Data service.');
    });

    it('returns null when every requested service is already enabled', () => {
      const result = applyRayfinYmlIdentityEdits(
        baseConfig,
        (baseConfig as { name: string }).name,
        undefined,
        ['auth', 'data']
      );

      expect(result).toBeNull();
    });
  });

  describe('isDataServiceEnabled', () => {
    // Locks in the contract used by both `applyRayfinYmlIdentityEdits`
    // (to gate `dialectChange`) and the call-site warning (`--dialect was
    // ignored ...`). The two predicates were drift-prone before this
    // helper existed; if they ever diverge again, the bug is "--dialect
    // silently injects into a disabled data block" and these tests would
    // be the closest failure surface.
    const cfg = (services: unknown) =>
      ({ services }) as unknown as Parameters<typeof isDataServiceEnabled>[0];

    it('returns true when services.data.enabled is true', () => {
      expect(
        isDataServiceEnabled(cfg({ data: { enabled: true, dialect: 'mssql' } }))
      ).toBe(true);
    });

    it('returns false when services.data.enabled is false', () => {
      expect(
        isDataServiceEnabled(
          cfg({ data: { enabled: false, dialect: 'mssql' } })
        )
      ).toBe(false);
    });

    it('returns false when services.data is missing', () => {
      expect(isDataServiceEnabled(cfg({ auth: { enabled: true } }))).toBe(
        false
      );
    });

    it('returns false when services itself is missing', () => {
      expect(isDataServiceEnabled(cfg(undefined))).toBe(false);
    });

    it('returns false when enabled is missing (only treats explicit true as enabled)', () => {
      expect(isDataServiceEnabled(cfg({ data: { dialect: 'mssql' } }))).toBe(
        false
      );
    });
  });
});

// Integration tests for data directory creation behavior
describe('init data directory behavior', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
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

  describe('data directory creation', () => {
    it('should create empty data directory when data service is enabled', async () => {
      const rayfinDir = join(testDir, 'rayfin');
      const dataDir = join(rayfinDir, 'data');

      // Simulate what init does - just create directory
      await mkdir(dataDir, { recursive: true });

      // Verify directory was created
      expect(await fileExists(dataDir)).toBe(true);
    });

    it('should not fail when data directory already exists', async () => {
      const rayfinDir = join(testDir, 'rayfin');
      const dataDir = join(rayfinDir, 'data');

      // Create data directory first
      await mkdir(dataDir, { recursive: true });
      expect(await fileExists(dataDir)).toBe(true);

      // Create it again with recursive: true (should not fail)
      await mkdir(dataDir, { recursive: true });
      expect(await fileExists(dataDir)).toBe(true);
    });
  });
});

// Integration tests for rayfin/tsconfig.json creation during init command
describe('init rayfin/tsconfig.json integration', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Save original cwd
    originalCwd = process.cwd();

    // Create a unique test directory
    testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create package.json to prevent rayfin package installation errors
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' }),
      'utf8'
    );

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(async () => {
    // Restore original cwd
    process.chdir(originalCwd);

    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Clear all mocks
    vi.clearAllMocks();
  });

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async function runInitCommand(
    options: {
      projectName?: string;
      fromTemplate?: boolean;
      services?: string[];
    } = {}
  ): Promise<void> {
    // Mock inquirer prompts
    const inquirer = await import('inquirer');
    vi.spyOn(inquirer.default, 'prompt').mockImplementation(
      async (questions: any) => {
        // Handle different prompt types
        if (Array.isArray(questions)) {
          const result: any = {};
          for (const q of questions) {
            if (q.name === 'projectName') {
              result.projectName = options.projectName || 'Test Project';
            } else if (q.name === 'services') {
              result.services = ['data']; // Minimal services for testing
            } else if (q.name === 'overwrite') {
              result.overwrite = true; // Auto-accept overwrites
            }
          }
          return result;
        } else {
          // Single question
          if (questions.name === 'overwrite') {
            return { overwrite: true };
          }
        }
        return {};
      }
    );

    const command = init();
    const args = ['.'];

    // Add options as command-line arguments
    if (options.projectName) {
      args.push('--project-name', options.projectName);
    }
    if (options.fromTemplate) {
      args.push('--from-template');
    }
    if (options.services) {
      args.push('--services', options.services.join(','));
    }
    // Always skip package installation in tests
    args.push('--skip-install');

    await command.parseAsync(args, { from: 'user' });
  }

  it('writes application auth in a from-scratch Functions project', async () => {
    await runInitCommand({
      projectName: 'Test Project',
      services: ['functions'],
    });

    const config = parse(
      await readFile(join(testDir, 'rayfin', 'rayfin.yml'), 'utf8')
    );
    expect(config.services.functions).toMatchObject({
      enabled: true,
      auth: { type: 'application' },
    });
    expect(
      await fileExists(
        join(testDir, 'rayfin', 'functions', 'src', 'function_app.ts')
      )
    ).toBe(true);
  });

  describe('tsconfig.json with extends', () => {
    it('should create rayfin/tsconfig.json with extends when base tsconfig.json exists', async () => {
      // Create base tsconfig.json
      const baseTsconfigPath = join(testDir, 'tsconfig.json');
      await writeFile(
        baseTsconfigPath,
        JSON.stringify({ compilerOptions: { target: 'es2020' } }, null, 2),
        'utf8'
      );

      // Run init command
      await runInitCommand({ projectName: 'Test Project' });

      // Verify rayfin/tsconfig.json was created
      const rayfinTsconfigPath = join(testDir, 'rayfin', 'tsconfig.json');
      expect(await fileExists(rayfinTsconfigPath)).toBe(true);

      // Read and verify content
      const content = await readFile(rayfinTsconfigPath, 'utf8');
      const config = JSON.parse(content);

      expect(config.extends).toBe('../tsconfig.json');
      expect(config.compilerOptions.outDir).toBe('.temp/compiled');
      expect(config.compilerOptions.rootDir).toBe('.');
      expect(config.compilerOptions.declaration).toBe(true);
      expect(config.compilerOptions.composite).toBe(true);
      expect(config.compilerOptions.noEmit).toBe(false);
      expect(config.compilerOptions.module).toBe('nodenext');
      expect(config.compilerOptions.moduleResolution).toBe('nodenext');
      expect(config.include).toEqual(['**/*']);
      // The "with extends" path also excludes the functions/ subfolder so
      // tsc in rayfin/ does not try to compile rayfin/functions/, which
      // owns its own tsconfig.json with a different module setting.
      expect(config.exclude).toEqual(['.temp/**/*', 'functions/**/*']);
    });
  });

  describe('tsconfig.json without extends', () => {
    it('should create rayfin/tsconfig.json without extends when base tsconfig.json does not exist', async () => {
      // Do not create base tsconfig.json

      // Run init command
      await runInitCommand({ projectName: 'Test Project' });

      // Verify rayfin/tsconfig.json was created
      const rayfinTsconfigPath = join(testDir, 'rayfin', 'tsconfig.json');
      expect(await fileExists(rayfinTsconfigPath)).toBe(true);

      // Read and verify content
      const content = await readFile(rayfinTsconfigPath, 'utf8');
      const config = JSON.parse(content);

      expect(config.extends).toBeUndefined();

      // Verify all required properties are present
      expect(config.compilerOptions).toBeDefined();
      expect(config.compilerOptions.outDir).toBe('.temp/compiled');
      expect(config.compilerOptions.rootDir).toBe('.');
      expect(config.compilerOptions.declaration).toBe(true);
      expect(config.compilerOptions.composite).toBe(true);
      expect(config.compilerOptions.noEmit).toBe(false);
      expect(config.compilerOptions.module).toBe('nodenext');
      expect(config.compilerOptions.moduleResolution).toBe('nodenext');
      expect(config.include).toEqual(['**/*']);
      expect(config.exclude).toEqual(['.temp/**/*']);
    });
  });

  describe('fromTemplate flag behavior', () => {
    it('enables application auth at a template Functions path without replacing its source', async () => {
      const rayfinDir = join(testDir, 'rayfin');
      const functionsDir = join(testDir, 'packages', 'functions');
      await mkdir(rayfinDir, { recursive: true });
      await mkdir(functionsDir, { recursive: true });
      await writeFile(join(functionsDir, 'template-marker.txt'), 'preserve');
      await writeFile(
        join(rayfinDir, 'rayfin.yml'),
        'id: template\nname: template\nservices:\n  functions:\n' +
          '    enabled: false\n    path: packages/functions\n    buildCommand: custom-build\n'
      );

      await runInitCommand({
        fromTemplate: true,
        projectName: 'Test Project',
        services: ['functions'],
      });

      const config = parse(
        await readFile(join(rayfinDir, 'rayfin.yml'), 'utf8')
      );
      expect(config.services.functions).toEqual({
        enabled: true,
        path: 'packages/functions',
        buildCommand: 'custom-build',
        auth: { type: 'application' },
      });
      expect(
        await readFile(join(functionsDir, 'template-marker.txt'), 'utf8')
      ).toBe('preserve');
      expect(await fileExists(join(rayfinDir, 'functions'))).toBe(false);
    });

    it('rejects delegated template auth before writing config or creating Functions', async () => {
      const rayfinDir = join(testDir, 'rayfin');
      await mkdir(rayfinDir, { recursive: true });
      const config =
        'id: template\nname: template\nservices:\n  functions:\n' +
        '    enabled: false\n    auth: { type: delegated }\n';
      await writeFile(join(rayfinDir, 'rayfin.yml'), config);

      await expect(
        runInitCommand({
          fromTemplate: true,
          projectName: 'Renamed Project',
          services: ['functions'],
        })
      ).rejects.toThrow('Set services.functions.auth.type to "application".');

      expect(await readFile(join(rayfinDir, 'rayfin.yml'), 'utf8')).toBe(
        config
      );
      expect(await fileExists(join(rayfinDir, 'functions'))).toBe(false);
    });

    it('should not create rayfin/tsconfig.json when fromTemplate is true', async () => {
      // Run init command with fromTemplate flag
      await runInitCommand({ fromTemplate: true, projectName: 'Test Project' });

      // Verify rayfin/tsconfig.json was NOT created
      const rayfinTsconfigPath = join(testDir, 'rayfin', 'tsconfig.json');
      expect(await fileExists(rayfinTsconfigPath)).toBe(false);
    });

    it('should preserve existing rayfin/tsconfig.json when fromTemplate is true', async () => {
      // Create rayfin directory and existing tsconfig
      const rayfinDir = join(testDir, 'rayfin');
      await mkdir(rayfinDir, { recursive: true });

      const rayfinTsconfigPath = join(rayfinDir, 'tsconfig.json');
      const existingContent = JSON.stringify(
        { compilerOptions: { target: 'es2020' } },
        null,
        2
      );
      await writeFile(rayfinTsconfigPath, existingContent, 'utf8');

      // Run init command with fromTemplate flag
      await runInitCommand({ fromTemplate: true, projectName: 'Test Project' });

      // Verify original content is preserved
      const content = await readFile(rayfinTsconfigPath, 'utf8');
      expect(content).toBe(existingContent);
    });

    it('honors custom service paths without creating default service directories', async () => {
      // Model the post-clone tree handed to `init --from-template`.
      const rayfinDir = join(testDir, 'rayfin');
      await mkdir(rayfinDir, { recursive: true });
      await writeFile(
        join(rayfinDir, 'rayfin.yml'),
        [
          'id: custom-paths',
          'name: custom-paths',
          'services:',
          '  auth:',
          '    enabled: false',
          '  data:',
          '    enabled: true',
          '    path: packages/data',
          '  storage:',
          '    enabled: true',
          '    path: packages/storage',
          '  functions:',
          '    enabled: true',
          '    path: packages/functions',
          '',
        ].join('\n'),
        'utf8'
      );

      for (const service of ['data', 'storage', 'functions']) {
        const customServiceDir = join(testDir, 'packages', service);
        await mkdir(customServiceDir, { recursive: true });
        await writeFile(
          join(customServiceDir, 'template-marker.txt'),
          service,
          'utf8'
        );
      }

      await runInitCommand({
        fromTemplate: true,
        projectName: 'Custom Paths App',
      });

      for (const service of ['data', 'storage', 'functions']) {
        expect(
          await fileExists(
            join(testDir, 'packages', service, 'template-marker.txt')
          )
        ).toBe(true);
        expect(await fileExists(join(rayfinDir, service))).toBe(false);
      }
    });

    // The next three tests cover the template-path dialect behavior:
    // - When `--dialect` is supplied against a template whose
    //   `services.data` is missing entirely, the call site warns (the
    //   helper has nowhere to land the flag).
    // - When `services.data` exists but `enabled: false`, the helper
    //   updates the dialect in place AND no warn fires (the flag was
    //   applied). The `enabled: false` is preserved so a later flip
    //   doesn't inherit a stale dialect from the template author.
    // - When `services.data.enabled: true`, the dialect is updated as
    //   before with no warning.
    async function writeRayfinYmlFixture(services: string[]): Promise<void> {
      const rayfinDir = join(testDir, 'rayfin');
      await mkdir(rayfinDir, { recursive: true });
      const lines = [
        'apiVersion: rayfin.microsoft.com/v0',
        'version: 1.0.0',
        'name: Template Original',
        'id: template-original',
        'services:',
        ...services,
      ];
      await writeFile(join(rayfinDir, 'rayfin.yml'), lines.join('\n'), 'utf8');
    }

    async function runFromTemplateWithDialect(): Promise<{
      warnings: string[];
    }> {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        try {
          await init().parseAsync(
            [
              '.',
              '--from-template',
              '--project-name',
              'Test',
              '--skip-install',
              '--dialect',
              'postgresql',
            ],
            { from: 'user' }
          );
        } catch {
          // Downstream scaffolding may throw in this isolated harness;
          // the warn fires before the throw so the assertion still holds.
        }
        return {
          warnings: warnSpy.mock.calls.flat().map(String),
        };
      } finally {
        warnSpy.mockRestore();
      }
    }

    it('warns and leaves services.data untouched when --dialect is supplied against a template with no data block', async () => {
      await writeRayfinYmlFixture(['  auth:', '    enabled: true']);
      const { warnings } = await runFromTemplateWithDialect();

      // Warning fires noting the flag was ignored.
      expect(warnings.join('\n')).toMatch(
        /--dialect postgresql was ignored.*no services\.data block/
      );

      // The on-disk rayfin.yml has NOT had services.data synthesized.
      const rayfinYml = await readFile(
        join(testDir, 'rayfin', 'rayfin.yml'),
        'utf8'
      );
      expect(rayfinYml).not.toMatch(/data:/);
      expect(rayfinYml).not.toMatch(/dialect:/);
    });

    it('updates the dialect without warning when --dialect is supplied against an explicitly disabled block', async () => {
      // The user's explicit `--dialect` is honored even when the
      // template ships `data: { enabled: false }`. This avoids the
      // stale-dialect trap where a user flips data on later and
      // discovers the template's preset dialect doesn't match their
      // backend (e.g. postgresql against Fabric). `enabled: false`
      // is preserved — we're updating a value, not flipping a service.
      await writeRayfinYmlFixture([
        '  data:',
        '    enabled: false',
        '    dialect: mssql',
      ]);
      const { warnings } = await runFromTemplateWithDialect();

      expect(warnings.join('\n')).not.toMatch(/--dialect.*was ignored/);

      const rayfinYml = await readFile(
        join(testDir, 'rayfin', 'rayfin.yml'),
        'utf8'
      );
      expect(rayfinYml).toMatch(/enabled:\s*false/);
      expect(rayfinYml).toMatch(/dialect:\s*postgresql/);
      expect(rayfinYml).not.toMatch(/dialect:\s*mssql/);
    });

    it('does not warn and updates the dialect when --dialect is supplied and services.data.enabled is already true', async () => {
      // Negative case: when the template already opts in to data, the
      // dialect just gets updated in place. No "was ignored" warning —
      // the flag was applied normally.
      await writeRayfinYmlFixture([
        '  data:',
        '    enabled: true',
        '    dialect: mssql',
      ]);
      const { warnings } = await runFromTemplateWithDialect();

      expect(warnings.join('\n')).not.toMatch(/--dialect.*was ignored/);

      const rayfinYml = await readFile(
        join(testDir, 'rayfin', 'rayfin.yml'),
        'utf8'
      );
      expect(rayfinYml).toMatch(/dialect:\s*postgresql/);
    });
  });

  describe('dialect flag against from-scratch (non-template) flows', () => {
    // The "warn on conflicting --dialect usage" rule applies to ALL
    // init/create flows, not just --from-template. In the from-scratch
    // path, the user can pass `--services auth` (or uncheck data
    // interactively) and have the data service excluded. If they ALSO
    // pass --dialect, the flag genuinely has no effect — `createRayfinYml`
    // writes `services.data.enabled: false` regardless. The CLI warns so
    // the user finds out instead of being silently overruled.

    async function runFromScratchWithDialect(
      services: string | undefined
    ): Promise<{ warnings: string[] }> {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        // Wrap init in a parent Command that declares `-y, --yes` so
        // the global flag propagates via `optsWithGlobals()` the way
        // the real CLI does in src/index.ts.
        const root = new Command('rayfin').option(
          '-y, --yes',
          'Auto-accept all confirmation prompts',
          false
        );
        root.addCommand(init());
        const args = [
          '--yes',
          'init',
          '.',
          '--project-name',
          'Test',
          '--skip-install',
          '--dialect',
          'postgresql',
        ];
        if (services !== undefined) {
          args.push('--services', services);
        }
        try {
          await root.parseAsync(args, { from: 'user' });
        } catch {
          // Downstream scaffolding may throw in this isolated harness;
          // the warn fires before the throw so the assertion still holds.
        }
        return { warnings: warnSpy.mock.calls.flat().map(String) };
      } finally {
        warnSpy.mockRestore();
      }
    }

    it('warns and leaves data disabled when --dialect is supplied with --services that excludes data', async () => {
      const { warnings } = await runFromScratchWithDialect('auth');

      expect(warnings.join('\n')).toMatch(
        /--dialect postgresql was ignored.*selected services do not include 'data'/
      );

      // The on-disk rayfin.yml has data disabled and no dialect applied.
      const rayfinYml = await readFile(
        join(testDir, 'rayfin', 'rayfin.yml'),
        'utf8'
      );
      expect(rayfinYml).toMatch(/data:\s*\n\s+enabled:\s*false/);
      expect(rayfinYml).not.toMatch(/dialect:\s*postgresql/);
    });

    it('does not warn and applies the dialect when --dialect is supplied and data is already in --services', async () => {
      const { warnings } = await runFromScratchWithDialect('data,auth');

      expect(warnings.join('\n')).not.toMatch(/--dialect.*was ignored/);

      const rayfinYml = await readFile(
        join(testDir, 'rayfin', 'rayfin.yml'),
        'utf8'
      );
      expect(rayfinYml).toMatch(/dialect:\s*postgresql/);
    });
  });

  describe('formatting and structure', () => {
    it('should format tsconfig.json with proper JSON structure', async () => {
      // Run init command
      await runInitCommand({ projectName: 'Test Project' });

      const rayfinTsconfigPath = join(testDir, 'rayfin', 'tsconfig.json');
      const content = await readFile(rayfinTsconfigPath, 'utf8');

      // Verify JSON is valid and properly formatted
      expect(() => JSON.parse(content)).not.toThrow();

      // Check for proper indentation (2 spaces)
      expect(content).toContain('  "compilerOptions"');
      expect(content).toContain('    "outDir"');

      // Verify trailing newline
      expect(content.endsWith('\n')).toBe(true);
    });

    it('should include all required compiler options', async () => {
      // Run init command
      await runInitCommand({ projectName: 'Test Project' });

      const rayfinTsconfigPath = join(testDir, 'rayfin', 'tsconfig.json');
      const content = await readFile(rayfinTsconfigPath, 'utf8');
      const config = JSON.parse(content);

      // Verify all required properties are present
      expect(config.compilerOptions).toBeDefined();
      expect(config.compilerOptions.outDir).toBe('.temp/compiled');
      expect(config.compilerOptions.rootDir).toBe('.');
      expect(config.compilerOptions.declaration).toBe(true);
      expect(config.compilerOptions.composite).toBe(true);
      expect(config.compilerOptions.noEmit).toBe(false);
      expect(config.compilerOptions.module).toBe('nodenext');
      expect(config.compilerOptions.moduleResolution).toBe('nodenext');
      expect(config.include).toEqual(['**/*']);
      expect(config.exclude).toEqual(['.temp/**/*']);
    });
  });
});

describe('init --item-id without --workspace-id', () => {
  it('should exit with error when --item-id is passed without --workspace-id', async () => {
    const command = init();
    const testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
      'utf8'
    );
    const originalCwd = process.cwd();
    process.chdir(testDir);

    let thrownError: unknown;
    try {
      await command.parseAsync(
        [
          '.',
          '--project-name',
          'Test',
          '--skip-install',
          '--item-id',
          'item-123',
        ],
        { from: 'user' }
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeDefined();
    expect((thrownError as Error).name).toBe('CliHandledError');
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
});

describe('init storage dependency JSON output', () => {
  it('emits one structured error when storage is selected without data', async () => {
    const testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    const originalCwd = process.cwd();
    const originalFeatureFlags = process.env.RAYFIN_FEATURE_FLAGS;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await mkdir(testDir, { recursive: true });
    process.chdir(testDir);
    process.env.RAYFIN_FEATURE_FLAGS = 'storage';

    try {
      const root = new Command('rayfin')
        .option('--json', 'Emit JSON output', false)
        .option('--yes', 'Run non-interactively', false);
      root.addCommand(init());

      await expect(
        root.parseAsync(
          [
            '--json',
            '--yes',
            'init',
            '.',
            '--project-name',
            'Test',
            '--skip-install',
            '--services',
            'storage',
          ],
          { from: 'user' }
        )
      ).rejects.toBeInstanceOf(CliHandledError);

      const outputLines = stdoutSpy.mock.calls
        .map((call: any) => String(call[0]).trim())
        .filter(Boolean);
      expect(outputLines).toHaveLength(1);
      expect(JSON.parse(outputLines[0])).toEqual({
        status: 'error',
        error: 'Storage requires the Data service.',
        hint: 'Include both "data" and "storage" in --services.',
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
      if (originalFeatureFlags === undefined) {
        delete process.env.RAYFIN_FEATURE_FLAGS;
      } else {
        process.env.RAYFIN_FEATURE_FLAGS = originalFeatureFlags;
      }
      stdoutSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe('init template storage dependency', () => {
  it('rejects a top-level template invocation when storage would lack data', async () => {
    const testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    const templateRoot = join(testDir, 'local-template');
    const originalCwd = process.cwd();
    const originalFeatureFlags = process.env.RAYFIN_FEATURE_FLAGS;

    await mkdir(join(templateRoot, 'rayfin'), { recursive: true });
    await writeFile(
      join(templateRoot, 'rayfin-template.yml'),
      'apiVersion: v1\nmetadata:\n  name: local\n  displayName: Local\nentries:\n  - name: local\n    path: .\n',
      'utf8'
    );
    await writeFile(
      join(templateRoot, 'rayfin', 'rayfin.yml'),
      'id: local\nname: Local\nversion: "1"\nservices:\n  auth:\n    enabled: false\n  data:\n    enabled: false\n  storage:\n    enabled: false\n',
      'utf8'
    );
    process.chdir(testDir);
    process.env.RAYFIN_FEATURE_FLAGS = 'storage';

    try {
      const root = new Command('rayfin').option(
        '--yes',
        'Run non-interactively',
        false
      );
      root.addCommand(init());

      await expect(
        root.parseAsync(
          [
            '--yes',
            'init',
            'local-app',
            '--template',
            './local-template',
            '--project-name',
            'Local App',
            '--skip-install',
            '--services',
            'storage',
          ],
          { from: 'user' }
        )
      ).rejects.toBeInstanceOf(CliHandledError);
    } finally {
      process.chdir(originalCwd);
      if (originalFeatureFlags === undefined) {
        delete process.env.RAYFIN_FEATURE_FLAGS;
      } else {
        process.env.RAYFIN_FEATURE_FLAGS = originalFeatureFlags;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe('init bundled template flags', () => {
  let exitSpy: any;

  let logSpy: any;

  let stderrSpy: any;

  let errorSpy: any;

  let stdoutSpy: any;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should list bundled templates as JSON with --list-templates', async () => {
    const command = init();
    try {
      await command.parseAsync(['.', '--list-templates'], { from: 'user' });
    } catch {
      // Commander may throw on exit
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    const stdoutOutput = stdoutSpy.mock.calls
      .map((c: any) => String(c[0]))
      .join('');
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed).toHaveProperty('schemaVersion', 1);
    expect(parsed).toHaveProperty('bundled');
    expect(parsed).toHaveProperty('registry');
    expect(Array.isArray(parsed.bundled)).toBe(true);
    expect(Array.isArray(parsed.registry)).toBe(true);
    expect(parsed.bundled.length).toBeGreaterThan(0);
    expect(parsed.bundled[0]).toHaveProperty('name');
    expect(parsed.bundled[0]).toHaveProperty('displayName');
    expect(parsed.bundled[0]).toHaveProperty('description');
    expect(parsed.bundled[0]).toHaveProperty('source', 'built-in');
    expect(parsed.bundled).toContainEqual(
      expect.objectContaining({
        name: 'dataapp',
        source: 'built-in',
      })
    );
    expect(parsed.registry.some((t: any) => t.name === 'dataapp')).toBe(false);
    expect(parsed.warnings).toBeUndefined();
  });

  // `--list-templates` is the listing an agent reads, so it filters hidden
  // templates. Resolution must not: the plugin scaffolds `universal-app` by
  // name. Assert both halves so a future filter in the lookup path fails here.
  it('should omit hidden templates from --list-templates but still resolve them', async () => {
    const discovered = discoverBundledTemplates();
    const hidden = discovered.filter((t) => t.hidden);
    expect(hidden.map((t) => t.name)).toContain('universal-app');

    const command = init();
    try {
      await command.parseAsync(['.', '--list-templates'], { from: 'user' });
    } catch {
      // Commander may throw on exit
    }

    const parsed = JSON.parse(
      stdoutSpy.mock.calls.map((c: any) => String(c[0])).join('')
    );
    const listed = parsed.bundled.map((t: any) => t.name);

    for (const template of hidden) {
      expect(listed).not.toContain(template.name);
    }
    // The visible ones are still listed, so this is not passing by listing nothing.
    for (const template of discovered.filter((t) => !t.hidden)) {
      expect(listed).toContain(template.name);
    }
  });

  it('should accept -l as short alias for --list-templates', async () => {
    const command = init();
    try {
      await command.parseAsync(['.', '-l'], { from: 'user' });
    } catch {
      // Commander may throw on exit
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    const stdoutOutput = stdoutSpy.mock.calls
      .map((c: any) => String(c[0]))
      .join('');
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed).toHaveProperty('bundled');
    expect(parsed).toHaveProperty('registry');
  });

  it('should include warnings in JSON when registry fails to load', async () => {
    const cwdRayfinDir = join(process.cwd(), '.rayfin');
    const registryPath = join(cwdRayfinDir, 'template-registries.yml');
    let createdDir = false;
    try {
      await mkdir(cwdRayfinDir, { recursive: true });
      createdDir = true;
      await writeFile(registryPath, 'invalid yaml: [[[unterminated');

      const command = init();
      try {
        await command.parseAsync(['.', '--list-templates'], { from: 'user' });
      } catch {
        // Commander may throw on exit
      }

      const stdoutOutput = stdoutSpy.mock.calls
        .map((c: any) => String(c[0]))
        .join('');
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.warnings).toBeDefined();
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.warnings.length).toBeGreaterThan(0);
      expect(parsed.registry).toEqual([]);
    } finally {
      await rm(registryPath, { force: true });
      if (createdDir) {
        await rm(cwdRayfinDir, { recursive: true, force: true });
      }
    }
  });

  it('should exit with error for unknown --template <name>', async () => {
    const command = init();
    let thrown: unknown;
    try {
      await command.parseAsync(
        ['.', '--template', 'nonexistent-template-xyz'],
        { from: 'user' }
      );
    } catch (err) {
      thrown = err;
    }

    // The bundled handler now throws CliHandledError instead of calling
    // process.exit(1) directly. The top-level CLI entry point (scripts/main)
    // catches CliHandledError and maps it to exit code 1; here we assert
    // the typed throw escapes parseAsync so the entry point can handle it.
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toMatch(/not found/i);

    // Regression for double-print: the outer catch in init.ts must honor
    // the CliHandledError "already shown" contract — re-printing here
    // would dump the CliHandledError stack via console.error's Error
    // formatting in addition to the friendly "❌ Template ... not found"
    // line the handler already emitted. Assert no second emission with
    // the "Error initializing project" prefix.
    const allErrorCalls = errorSpy.mock.calls.flat().map(String).join('\n');
    const allStderrCalls = stderrSpy.mock.calls.flat().map(String).join('\n');
    expect(allErrorCalls).not.toMatch(/Error initializing project/);
    expect(allStderrCalls).not.toMatch(/Error initializing project/);
  });

  it('throws a handled error for conflicting --template-name on first-class aliases', async () => {
    const command = init();
    let thrown: unknown;

    try {
      await command.parseAsync(
        ['.', '--template', 'dataapp', '--template-name', 'Other App'],
        { from: 'user' }
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliHandledError);
    expect((thrown as Error).message).toContain(
      "--template-name cannot override first-class template 'dataapp'"
    );
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    const allErrorCalls = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(allErrorCalls).toContain(
      "--template-name cannot override first-class template 'dataapp'"
    );
  });

  it('prints a friendly error before throwing CliHandledError on each handleBundledTemplate failure path', async () => {
    // Regression for the "CliHandledError-without-modeError" gap. Every
    // throw site in handleBundledTemplate must call modeError BEFORE
    // throwing, because all CliHandledError catchers (init.ts:1957,
    // scripts/main, create-rayfin) honor the "message already shown"
    // contract and suppress re-print. Without modeError at the throw
    // site, the user gets exit 1 with empty stderr — especially painful
    // for agents/CI scripts (e.g. running `rayfin init` non-interactively
    // without --template).
    const { handleBundledTemplate } =
      await import('../commands/init-bundled-template.js');
    const captureMode = 'plain' as const;

    // Path 1: --template required in non-interactive mode (Chris's
    // primary concern — agents/CI hit this on `rayfin init` without -t).
    let thrown: unknown;
    try {
      await handleBundledTemplate('.', captureMode, { nonInteractive: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliHandledError);
    expect((thrown as Error).message).toMatch(/--template is required/i);
    const allErrorCalls = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(allErrorCalls).toMatch(/--template is required in non-interactive/i);
  });

  it('should not run bundled template flow when --from-template is set', async () => {
    // --from-template is set by automation (create-rayfin) to indicate
    // the template has already been applied and init should run the config wizard
    const command = init();
    const testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
      'utf8'
    );
    const originalCwd = process.cwd();
    process.chdir(testDir);

    try {
      await command.parseAsync(
        [
          '.',
          '--template',
          'my-app',
          '--from-template',
          '--project-name',
          'Test',
          '--skip-install',
        ],
        { from: 'user' }
      );
    } catch {
      // May throw during config wizard execution
    }

    // Should NOT have exited with 0 from the redirect path
    const redirectOutput = [
      ...logSpy.mock.calls.map((c: any) => c.join(' ')),
      ...stderrSpy.mock.calls.map((c: any) => String(c[0])),
    ].join('\n');
    expect(redirectOutput).not.toContain('npx @microsoft/create-rayfin');

    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
});

describe('init interactive picker', () => {
  let exitSpy: any;

  let logSpy: any;

  let stderrSpy: any;

  let promptSpy: any;
  let testDir: string;
  let originalCwd: string;
  let originalIsTTY: boolean | undefined;
  let originalCI: string | undefined;

  beforeEach(async () => {
    // Clear CI env so isInteractive() returns true when isTTY is set
    originalCI = process.env.CI;
    delete process.env.CI;

    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Force interactive mode by faking a TTY
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });

    testDir = join(tmpdir(), `rayfin-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
      'utf8'
    );
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    stderrSpy.mockRestore();
    promptSpy?.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    if (originalCI !== undefined) {
      process.env.CI = originalCI;
    } else {
      delete process.env.CI;
    }
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function getAllOutput(): string {
    return [
      ...logSpy.mock.calls.map((c: any) => c.join(' ')),
      ...stderrSpy.mock.calls.map((c: any) => String(c[0])),
    ].join('\n');
  }

  it('should enter bundled template flow when user picks "Use a template"', async () => {
    const inquirerModule = await import('inquirer');
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const askedQuestions: string[] = [];
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const q = Array.isArray(questions) ? questions[0] : questions;
        askedQuestions.push(q.name);
        if (q.name === 'source') return { source: 'template' };
        if (q.name === 'template') {
          return {
            template: {
              name: 'blankapp',
              displayName: 'Blank App',
              description: 'Blank App',
              path: '',
              packageJson: {},
              isLocal: false,
            },
          };
        }
        return {};
      });

    const command = init();
    try {
      await command.parseAsync(['.'], { from: 'user' });
    } catch {
      // Expected — downstream scaffolding is not stubbed in this test
    }

    // Should have asked for source first, then template selection (bundled flow)
    expect(askedQuestions).toContain('source');
    expect(askedQuestions).toContain('template');
    // Should NOT have asked for a git URL
    expect(askedQuestions).not.toContain('templateUrl');

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }, 15000);

  it('should prompt for git URL when user picks "Use an external git template"', async () => {
    const inquirerModule = await import('inquirer');
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const askedQuestions: string[] = [];
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const q = Array.isArray(questions) ? questions[0] : questions;
        askedQuestions.push(q.name);
        if (q.name === 'source') return { source: 'external' };
        if (q.name === 'gitUrl')
          return { gitUrl: 'https://github.com/org/template.git' };
        return {};
      });

    const command = init();
    try {
      await command.parseAsync(['.'], { from: 'user' });
    } catch {
      // Expected — fetchTemplate will fail (no real repo)
    }

    // Should have asked for source, then git URL (external flow)
    expect(askedQuestions).toContain('source');
    expect(askedQuestions).toContain('gitUrl');
    // Should NOT have entered the bundled template picker
    expect(askedQuestions).not.toContain('template');

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }, 15000);

  it('should continue to config wizard when user picks "Start from scratch"', async () => {
    const inquirerModule = await import('inquirer');
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        if (Array.isArray(questions)) {
          const q = questions[0];
          if (q.name === 'source') return { source: 'scratch' };
          if (q.name === 'projectName') return { projectName: 'Test' };
          if (q.name === 'services') return { services: ['data'] };
        }
        if (questions.name === 'source') return { source: 'scratch' };
        if (questions.name === 'projectName') return { projectName: 'Test' };
        if (questions.name === 'services') return { services: ['data'] };
        return {};
      });

    const command = init();
    try {
      await command.parseAsync(
        ['.', '--project-name', 'Test', '--skip-install'],
        {
          from: 'user',
        }
      );
    } catch {
      // May throw during config wizard
    }

    // Should see the Rayfin header from the config wizard, not the template flow
    expect(getAllOutput()).toContain('Rayfin');
  });

  it('persists create provenance after a successful scratch scaffold', async () => {
    const originId = '9f970daa-6101-4df2-98f9-e0d86e975c61';
    const inquirerModule = await import('inquirer');
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const list = Array.isArray(questions) ? questions : [questions];
        const answers: Record<string, unknown> = {};
        for (const question of list) {
          if (question.name === 'source') answers.source = 'scratch';
          else if (question.name === 'services') answers.services = ['data'];
          else if (question.name === 'enableStatic') {
            answers.enableStatic = false;
          }
        }
        return answers;
      });

    await init({
      createProjectSemantics: true,
      getProjectOriginId: () => originId,
    }).parseAsync(['.', '--project-name', 'Test', '--skip-install'], {
      from: 'user',
    });

    expect(
      JSON.parse(
        await readFile(join(testDir, 'rayfin', '.project.json'), 'utf8')
      )
    ).toEqual({
      _comment:
        'Created by create-rayfin to correlate anonymous scaffold and deployment telemetry. Commit this file with your project.',
      version: 1,
      projectOriginId: originId,
    });
  });

  it.each([false, true])(
    'defers workspace lookup without a login (ignored item ID: %s)',
    async (withItemId) => {
      const resolver = await import('../utils/resolve-workspace-name.js');
      const { readEnvMap } = await import('../utils/env-file-utils.js');
      const lookupSpy = vi
        .spyOn(resolver, 'resolveWorkspaceIdByName')
        .mockRejectedValue(new Error('No cached Fabric session'));
      const inquirerModule = await import('inquirer');
      promptSpy = vi
        .spyOn(inquirerModule.default, 'prompt')
        .mockImplementation(async () => ({
          source: 'scratch',
          services: ['data'],
          enableStatic: false,
        }));

      try {
        await init({ createProjectSemantics: true }).parseAsync(
          [
            '.',
            '--project-name',
            'Test',
            '--workspace',
            'Finance # Reporting',
            '--skip-install',
            ...(withItemId
              ? ['--item-id', '0ec75687-db68-4aaa-83d2-103f0202b029']
              : []),
          ],
          { from: 'user' }
        );

        expect(lookupSpy).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        await expect(
          access(join(testDir, 'rayfin', 'rayfin.yml'))
        ).resolves.toBeUndefined();
        const env = await readEnvMap(join(testDir, 'rayfin'));
        expect(env.get('RAYFIN_WORKSPACE_NAME')).toBe('Finance # Reporting');
      } finally {
        lookupSpy.mockRestore();
      }
    }
  );

  it.each(['scratch', 'local template'])(
    'preserves workspace and item IDs without authentication for a %s create scaffold',
    async (source) => {
      const hydration = await import('../utils/hydrate-deployment.js');
      const { listDeploymentsState } =
        await import('../utils/deployments-registry.js');
      const hydrationSpy = vi
        .spyOn(hydration, 'hydrateDeploymentFromFabric')
        .mockRejectedValue(new Error('No cached Fabric session'));
      const inquirerModule = await import('inquirer');
      promptSpy = vi
        .spyOn(inquirerModule.default, 'prompt')
        .mockImplementation(async () => ({
          source: 'scratch',
          services: ['data'],
          enableStatic: false,
        }));
      const projectDir = join(testDir, 'created-app');
      const workspaceId = '767f94fa-1106-4377-8fb4-bb931907444a';
      const itemId = '0ec75687-db68-4aaa-83d2-103f0202b029';
      const templateArgs: string[] = [];
      if (source === 'local template') {
        const templateDir = join(testDir, 'local-template');
        await mkdir(join(templateDir, 'rayfin'), { recursive: true });
        await writeFile(
          join(templateDir, 'rayfin-template.yml'),
          'apiVersion: v1\nmetadata:\n  name: local\nentries:\n  - name: local\n    path: .\n'
        );
        await writeFile(
          join(templateDir, 'package.json'),
          JSON.stringify({ name: 'local-template', version: '1.0.0' })
        );
        await writeFile(
          join(templateDir, 'rayfin', 'rayfin.yml'),
          'id: local\nname: Local\nversion: "1"\nservices:\n  auth:\n    enabled: false\n  data:\n    enabled: false\n'
        );
        templateArgs.push('--template', templateDir);
      }

      try {
        await init({ createProjectSemantics: true }).parseAsync(
          [
            projectDir,
            '--project-name',
            'Created App',
            '--workspace-id',
            workspaceId,
            '--item-id',
            itemId,
            '--skip-install',
            ...templateArgs,
          ],
          { from: 'user' }
        );

        expect(hydrationSpy).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(listDeploymentsState(projectDir).deployments).toMatchObject([
          { record: { workspaceId, itemId } },
        ]);
      } finally {
        hydrationSpy.mockRestore();
      }
    },
    15_000
  );

  it('persists create provenance after a successful local-template scaffold', async () => {
    const originId = '9f970daa-6101-4df2-98f9-e0d86e975c61';
    const templateRoot = join(testDir, 'local-template');
    await mkdir(join(templateRoot, 'rayfin'), { recursive: true });
    await writeFile(
      join(templateRoot, 'rayfin-template.yml'),
      'apiVersion: v1\nmetadata:\n  name: local\n  displayName: Local\nentries:\n  - name: local\n    path: .\n',
      'utf8'
    );
    await writeFile(
      join(templateRoot, 'package.json'),
      JSON.stringify({ name: 'local-template', version: '1.0.0' }),
      'utf8'
    );
    await writeFile(
      join(templateRoot, 'rayfin', 'rayfin.yml'),
      'id: local\nname: Local\nversion: "1"\nservices:\n  auth:\n    enabled: false\n  data:\n    enabled: false\n',
      'utf8'
    );

    await init({ getProjectOriginId: () => originId }).parseAsync(
      [
        '--template',
        './local-template',
        '--project-name',
        'Local App',
        '--skip-install',
        'local-app',
      ],
      { from: 'user' }
    );

    expect(
      JSON.parse(
        await readFile(
          join(testDir, 'local-app', 'rayfin', '.project.json'),
          'utf8'
        )
      )
    ).toEqual({
      _comment:
        'Created by create-rayfin to correlate anonymous scaffold and deployment telemetry. Commit this file with your project.',
      version: 1,
      projectOriginId: originId,
    });
  }, 15000);

  it('does not persist create provenance when scratch overwrite is declined', async () => {
    const originId = '9f970daa-6101-4df2-98f9-e0d86e975c61';
    await mkdir(join(testDir, 'rayfin'), { recursive: true });
    await writeFile(join(testDir, 'rayfin', 'rayfin.yml'), 'id: existing\n');
    const inquirerModule = await import('inquirer');
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const question = Array.isArray(questions) ? questions[0] : questions;
        if (question.name === 'source') return { source: 'scratch' };
        if (question.name === 'overwrite') return { overwrite: false };
        return {};
      });

    await expect(
      init({
        createProjectSemantics: true,
        getProjectOriginId: () => originId,
      }).parseAsync(['.', '--project-name', 'Test', '--skip-install'], {
        from: 'user',
      })
    ).resolves.toBeDefined();
    await expect(
      access(join(testDir, 'rayfin', '.project.json'))
    ).rejects.toThrow();
  });

  it('should only show Fabric auth for scratch when create-project semantics are enabled', async () => {
    const inquirerModule = await import('inquirer');
    let authMethodChoices: Array<{ value: string; checked?: boolean }> = [];

    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const list = Array.isArray(questions) ? questions : [questions];
        const answers: Record<string, unknown> = {};
        for (const q of list) {
          if (q.name === 'source') answers.source = 'scratch';
          else if (q.name === 'services') answers.services = ['auth'];
          else if (q.name === 'authMethods') {
            authMethodChoices = q.choices;
            answers.authMethods = ['fabric'];
          } else if (q.name === 'enableStatic') {
            answers.enableStatic = false;
          } else if (q.name === 'overwrite') {
            answers.overwrite = true;
          }
        }
        return answers;
      });

    const command = init({ createProjectSemantics: true });
    try {
      await command.parseAsync(
        ['.', '--project-name', 'Test', '--skip-install'],
        {
          from: 'user',
        }
      );
    } catch {
      // May throw during config wizard
    }

    expect(authMethodChoices.map((choice) => choice.value)).toEqual(['fabric']);
    expect(authMethodChoices[0]?.checked).toBe(true);
  });

  it('should only show Fabric auth for scratch in standalone init mode', async () => {
    const inquirerModule = await import('inquirer');
    let authMethodChoices: Array<{ value: string; checked?: boolean }> = [];

    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const list = Array.isArray(questions) ? questions : [questions];
        const answers: Record<string, unknown> = {};
        for (const q of list) {
          if (q.name === 'source') answers.source = 'scratch';
          else if (q.name === 'services') answers.services = ['auth'];
          else if (q.name === 'authMethods') {
            authMethodChoices = q.choices;
            answers.authMethods = ['fabric'];
          } else if (q.name === 'enableStatic') {
            answers.enableStatic = false;
          } else if (q.name === 'overwrite') {
            answers.overwrite = true;
          }
        }
        return answers;
      });

    const command = init();
    try {
      await command.parseAsync(
        ['.', '--project-name', 'Test', '--skip-install'],
        {
          from: 'user',
        }
      );
    } catch {
      // May throw during config wizard
    }

    expect(authMethodChoices.map((choice) => choice.value)).toEqual(['fabric']);
    expect(authMethodChoices[0]?.checked).toBe(true);
  });

  it('should skip picker when --from-template is set', async () => {
    const inquirerModule = await import('inquirer');
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        if (Array.isArray(questions)) {
          const q = questions[0];
          // Should never ask about source when --from-template is set
          expect(q.name).not.toBe('source');
          if (q.name === 'projectName') return { projectName: 'Test' };
          if (q.name === 'services') return { services: ['data'] };
        }
        return {};
      });

    const command = init();
    try {
      await command.parseAsync(
        ['.', '--from-template', '--project-name', 'Test', '--skip-install'],
        { from: 'user' }
      );
    } catch {
      // May throw during execution
    }

    // Verify no template picker was shown (no source prompt)
    const sourcePromptCalls = promptSpy.mock.calls.filter((call: any) => {
      const questions = call[0];
      if (Array.isArray(questions)) {
        return questions.some((q: any) => q.name === 'source');
      }
      return (questions as any).name === 'source';
    });
    expect(sourcePromptCalls).toHaveLength(0);
  });

  it('should skip picker in non-interactive mode (no TTY)', async () => {
    // Restore isTTY to undefined to simulate non-interactive
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const inquirerModule = await import('inquirer');
    promptSpy = vi.spyOn(inquirerModule.default, 'prompt');

    const command = init();
    try {
      await command.parseAsync(
        ['.', '--project-name', 'Test', '--skip-install'],
        { from: 'user' }
      );
    } catch {
      // May throw during execution
    }

    // In non-interactive mode, no source picker should be shown
    const sourcePromptCalls = promptSpy.mock.calls.filter((call: any) => {
      const questions = call[0];
      if (Array.isArray(questions)) {
        return questions.some((q: any) => q.name === 'source');
      }
      return (questions as any).name === 'source';
    });
    expect(sourcePromptCalls).toHaveLength(0);
  });

  // Each entry exercises one of the Fabric-targeting flags that should
  // suppress the interactive dialect prompt and default to MSSQL (the only
  // dialect Microsoft Fabric currently supports).
  const fabricFlagCases: Array<{ label: string; args: string[] }> = [
    {
      label: '--workspace-id',
      args: ['--workspace-id', 'c7dcf903-4e8f-4de2-8df6-fe029c95bea1'],
    },
    {
      label: '--item-id',
      args: [
        '--workspace-id',
        'c7dcf903-4e8f-4de2-8df6-fe029c95bea1',
        '--item-id',
        '0ec75687-db68-4aaa-83d2-103f0202b029',
      ],
    },
    {
      label: '--workspace-uri',
      args: [
        '--workspace-uri',
        'https://app.fabric.microsoft.com/groups/00000000-0000-0000-0000-000000000000',
      ],
    },
    {
      label: '--base-api-url',
      args: ['--base-api-url', 'https://api.fabric.microsoft.com'],
    },
  ];

  it.each(fabricFlagCases)(
    'should skip dialect prompt and default to MSSQL when $label is provided in interactive mode',
    async ({ args }) => {
      const inquirerModule = await import('inquirer');
      const askedQuestions: string[] = [];
      promptSpy = vi
        .spyOn(inquirerModule.default, 'prompt')
        .mockImplementation(async (questions: any) => {
          const list = Array.isArray(questions) ? questions : [questions];
          for (const q of list) {
            askedQuestions.push(q.name);
          }
          const answers: any = {};
          for (const q of list) {
            if (q.name === 'source') answers.source = 'scratch';
            else if (q.name === 'services') answers.services = ['data'];
            else if (q.name === 'authMethods') answers.authMethods = [];
            else if (q.name === 'enableEmail') answers.enableEmail = false;
            else if (q.name === 'enableStatic') answers.enableStatic = false;
            else if (q.name === 'overwrite') answers.overwrite = true;
          }
          return answers;
        });

      const command = init();
      try {
        await command.parseAsync(
          ['.', '--project-name', 'Test', ...args, '--skip-install'],
          { from: 'user' }
        );
      } catch {
        // May throw during execution paths unrelated to dialect resolution
      }

      // The dialect prompt must never be presented to the user when any
      // Fabric-targeting flag is provided.
      expect(askedQuestions).not.toContain('dialect');

      // The generated rayfin.yml must default to mssql for the data service.
      const rayfinYml = await readFile(
        join(testDir, 'rayfin', 'rayfin.yml'),
        'utf8'
      );
      const config = parse(rayfinYml);
      expect(config.services.data.enabled).toBe(true);
      expect(config.services.data.dialect).toBe('mssql');
    }
  );

  it('should still prompt for dialect when no Fabric-targeting flags are provided', async () => {
    const inquirerModule = await import('inquirer');
    const askedQuestions: string[] = [];
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const list = Array.isArray(questions) ? questions : [questions];
        for (const q of list) {
          askedQuestions.push(q.name);
        }
        const answers: any = {};
        for (const q of list) {
          if (q.name === 'source') answers.source = 'scratch';
          else if (q.name === 'services') answers.services = ['data'];
          else if (q.name === 'dialect') answers.dialect = 'postgresql';
          else if (q.name === 'authMethods') answers.authMethods = [];
          else if (q.name === 'enableEmail') answers.enableEmail = false;
          else if (q.name === 'enableStatic') answers.enableStatic = false;
          else if (q.name === 'overwrite') answers.overwrite = true;
        }
        return answers;
      });

    // Enable postgresql feature flag so the dialect prompt has multiple options
    const originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
    process.env.RAYFIN_FEATURE_FLAGS = 'postgresql';

    const command = init();
    try {
      await command.parseAsync(
        ['.', '--project-name', 'Test', '--skip-install'],
        { from: 'user' }
      );
    } catch {
      // May throw during execution paths unrelated to dialect resolution
    } finally {
      if (originalFlags !== undefined) {
        process.env.RAYFIN_FEATURE_FLAGS = originalFlags;
      } else {
        delete process.env.RAYFIN_FEATURE_FLAGS;
      }
    }

    // Without Fabric identifiers, the dialect prompt should run as usual.
    expect(askedQuestions).toContain('dialect');
  });

  it('should auto-select mssql without dialect prompt when postgresql flag is inactive', async () => {
    const inquirerModule = await import('inquirer');
    const askedQuestions: string[] = [];
    promptSpy = vi
      .spyOn(inquirerModule.default, 'prompt')
      .mockImplementation(async (questions: any) => {
        const list = Array.isArray(questions) ? questions : [questions];
        for (const q of list) {
          askedQuestions.push(q.name);
        }
        const answers: any = {};
        for (const q of list) {
          if (q.name === 'source') answers.source = 'scratch';
          else if (q.name === 'services') answers.services = ['data'];
          else if (q.name === 'authMethods') answers.authMethods = [];
          else if (q.name === 'enableEmail') answers.enableEmail = false;
          else if (q.name === 'enableStatic') answers.enableStatic = false;
          else if (q.name === 'overwrite') answers.overwrite = true;
        }
        return answers;
      });

    // Ensure postgresql feature flag is NOT set
    const originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
    delete process.env.RAYFIN_FEATURE_FLAGS;

    const command = init();
    try {
      await command.parseAsync(
        ['.', '--project-name', 'Test', '--skip-install'],
        { from: 'user' }
      );
    } catch {
      // May throw during execution paths unrelated to dialect resolution
    } finally {
      if (originalFlags !== undefined) {
        process.env.RAYFIN_FEATURE_FLAGS = originalFlags;
      }
    }

    // With only one dialect available, the prompt should be skipped
    expect(askedQuestions).not.toContain('dialect');

    // The generated rayfin.yml must default to mssql
    const rayfinYml = await readFile(
      join(testDir, 'rayfin', 'rayfin.yml'),
      'utf8'
    );
    const config = parse(rayfinYml);
    expect(config.services.data.dialect).toBe('mssql');
  });
});

describe('isLocalPath', () => {
  it('detects the bare current-directory path "."', () => {
    expect(isLocalPath('.')).toBe(true);
  });

  it('detects the bare parent-directory path ".."', () => {
    expect(isLocalPath('..')).toBe(true);
  });

  it('detects relative paths with ./', () => {
    expect(isLocalPath('./my-template')).toBe(true);
  });

  it('detects parent paths with ../', () => {
    expect(isLocalPath('../templates/starter')).toBe(true);
  });

  it('detects Windows relative paths with .\\', () => {
    expect(isLocalPath('.\\my-template')).toBe(true);
  });

  it('detects Windows parent paths with ..\\', () => {
    expect(isLocalPath('..\\templates')).toBe(true);
  });

  it('detects absolute POSIX paths', () => {
    expect(isLocalPath('/home/user/template')).toBe(true);
  });

  it('rejects git URLs', () => {
    expect(isLocalPath('https://github.com/org/repo.git')).toBe(false);
  });

  it('rejects bare names', () => {
    expect(isLocalPath('my-template')).toBe(false);
  });

  it('rejects SSH URLs', () => {
    expect(isLocalPath('git@github.com:org/repo.git')).toBe(false);
  });
});

describe('selectTemplateEntry', () => {
  it('auto-selects when manifest has a single entry', async () => {
    const testDir = join(tmpdir(), `rayfin-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'rayfin-template.yml'),
      'apiVersion: v1\nmetadata:\n  name: inner\nentries:\n  - name: inner\n    path: .\n'
    );

    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'test' },
      entries: [{ name: 'my-template', path: '.' }],
    };

    const result = await selectTemplateEntry(manifest, testDir, {
      interactive: false,
    });

    expect(result.manifest.metadata.name).toBe('inner');
    rmSync(testDir, { recursive: true, force: true });
  });

  it('throws for multi-entry manifest in non-interactive mode', async () => {
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'test' },
      entries: [
        { name: 'starter', path: 'templates/starter' },
        { name: 'advanced', path: 'templates/advanced' },
      ],
    };
    const root = tmpdir();

    await expect(
      selectTemplateEntry(manifest, root, { interactive: false })
    ).rejects.toThrow('multiple entries');
  });

  it('selects nested grouped entries by template name', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'rayfin-group-test-'));
    const templateRoot = join(tmpRoot, 'template');
    const leafRoot = join(templateRoot, 'starters', 'api-service');
    mkdirSync(leafRoot, { recursive: true });
    writeFileSync(
      join(leafRoot, 'rayfin-template.yml'),
      'apiVersion: v1\nmetadata:\n  name: api-service\nentries:\n  - name: api-service\n    path: .\n'
    );

    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'grouped' },
      entries: [
        {
          group: {
            name: 'starters',
            displayName: 'Starters',
            entries: [
              {
                name: 'api-service',
                path: 'starters/api-service',
              },
            ],
          },
        },
      ],
    };

    const result = await selectTemplateEntry(manifest, templateRoot, {
      interactive: false,
      templateName: 'api-service',
    });

    expect(result.manifest.metadata.name).toBe('api-service');
    expect(result.sourcePath).toContain(join('starters', 'api-service'));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists flattened grouped template names on miss', async () => {
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'grouped' },
      entries: [
        {
          group: {
            name: 'starters',
            displayName: 'Starters',
            entries: [
              { name: 'api-service', path: 'starters/api-service' },
              { name: 'worker-service', path: 'starters/worker-service' },
            ],
          },
        },
      ],
    };

    await expect(
      selectTemplateEntry(manifest, tmpdir(), {
        interactive: false,
        templateName: 'missing',
      })
    ).rejects.toThrow('Available: api-service, worker-service');
  });

  it('uses breadcrumb navigation for grouped manifests in interactive mode', async () => {
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'grouped' },
      entries: [
        {
          group: {
            name: 'starters',
            displayName: 'Starters',
            entries: [
              { name: 'api-service', path: 'starters/api-service' },
              { name: 'worker-service', path: 'starters/worker-service' },
            ],
          },
        },
      ],
    };
    const resolved = {
      manifest: {
        apiVersion: 'v1' as const,
        metadata: { name: 'api-service' },
        entries: [{ name: 'api-service', path: '.' }],
      },
      sourcePath: join(tmpdir(), 'selected'),
    };
    vi.mocked(navigateCatalog).mockResolvedValue(resolved);

    await expect(
      selectTemplateEntry(manifest, tmpdir(), { interactive: true })
    ).resolves.toBe(resolved);
    expect(navigateCatalog).toHaveBeenCalledWith(manifest, tmpdir());
  });

  it('auto-selects a single leaf nested in a group without navigating', async () => {
    vi.mocked(navigateCatalog).mockClear();
    const tmpRoot = mkdtempSync(join(process.cwd(), '.tmp-rayfin-selector-'));
    const templateRoot = join(tmpRoot, 'template');
    const leafRoot = join(templateRoot, 'starters', 'api-service');
    mkdirSync(leafRoot, { recursive: true });
    writeFileSync(
      join(leafRoot, 'rayfin-template.yml'),
      [
        "apiVersion: 'v1'",
        'metadata:',
        '  name: api-service',
        'entries:',
        '  - name: api-service',
        '    path: .',
      ].join('\n')
    );
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'grouped' },
      entries: [
        {
          group: {
            name: 'starters',
            displayName: 'Starters',
            entries: [{ name: 'api-service', path: 'starters/api-service' }],
          },
        },
      ],
    };

    try {
      const result = await selectTemplateEntry(manifest, templateRoot, {
        interactive: true,
      });

      expect(result.manifest.metadata.name).toBe('api-service');
      expect(result.sourcePath).toContain(join('starters', 'api-service'));
      expect(navigateCatalog).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects entry path that escapes template root', async () => {
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'test' },
      entries: [{ name: 'evil', path: '../../etc' }],
    };
    const root = join(tmpdir(), 'some-template');

    await expect(
      selectTemplateEntry(manifest, root, { interactive: false })
    ).rejects.toThrow('..');
  });

  it('rejects entry path that escapes via symlink', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'rayfin-symlink-test-'));
    const outsideDir = join(tmpRoot, 'outside');
    const templateRoot = join(tmpRoot, 'template');
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(templateRoot, { recursive: true });

    // Create a symlink inside templateRoot that points outside
    try {
      symlinkSync(outsideDir, join(templateRoot, 'escape'), 'dir');
    } catch {
      // Skip on Windows without admin/dev mode
      rmSync(tmpRoot, { recursive: true, force: true });
      return;
    }

    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'test' },
      entries: [{ name: 'evil', path: 'escape' }],
    };

    await expect(
      selectTemplateEntry(manifest, templateRoot, { interactive: false })
    ).rejects.toThrow(/escapes/i);

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws when the manifest has no entries', async () => {
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'empty' },
      entries: [],
    };

    await expect(
      selectTemplateEntry(manifest, tmpdir(), { interactive: false })
    ).rejects.toThrow('Manifest contains no entries');
  });

  it('throws with each matching entry when --template-name is ambiguous', async () => {
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'grouped' },
      entries: [
        {
          group: {
            name: 'alpha',
            displayName: 'Alpha',
            entries: [{ name: 'svc', path: 'alpha/svc' }],
          },
        },
        {
          group: {
            name: 'beta',
            displayName: 'Beta',
            entries: [{ name: 'svc', path: 'beta/svc' }],
          },
        },
      ],
    };

    await expect(
      selectTemplateEntry(manifest, tmpdir(), {
        interactive: false,
        templateName: 'svc',
      })
    ).rejects.toThrow(/is ambiguous.*matches 2 entries.*alpha\/svc.*beta\/svc/);
  });

  it('warns via onPathFallback when --template-name matches a path not a name', async () => {
    vi.mocked(navigateCatalog).mockClear();
    const tmpRoot = mkdtempSync(
      join(process.cwd(), '.tmp-rayfin-pathfallback-')
    );
    const leafRoot = join(tmpRoot, 'sub');
    mkdirSync(leafRoot, { recursive: true });
    writeFileSync(
      join(leafRoot, 'rayfin-template.yml'),
      [
        "apiVersion: 'v1'",
        'metadata:',
        '  name: sub-template',
        'entries:',
        '  - name: sub-template',
        '    path: .',
      ].join('\n')
    );
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'root' },
      entries: [{ name: 'api', path: 'sub' }],
    };
    const onPathFallback = vi.fn();

    try {
      await selectTemplateEntry(manifest, tmpRoot, {
        interactive: false,
        templateName: 'sub',
        onPathFallback,
      });

      expect(onPathFallback).toHaveBeenCalledWith(
        expect.stringContaining("No template named 'sub'")
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('routes flat interactive multi-entry through navigateCatalog', async () => {
    vi.mocked(navigateCatalog).mockClear();
    const manifest = {
      apiVersion: 'v1' as const,
      metadata: { name: 'flat', displayName: 'Flat catalog' },
      entries: [
        { name: 'api-service', path: 'api-service' },
        { name: 'worker-service', path: 'worker-service' },
      ],
    };
    const resolved = {
      manifest: {
        apiVersion: 'v1' as const,
        metadata: { name: 'api-service' },
        entries: [{ name: 'api-service', path: '.' }],
      },
      sourcePath: join(tmpdir(), 'selected'),
    };
    vi.mocked(navigateCatalog).mockResolvedValue(resolved);

    await expect(
      selectTemplateEntry(manifest, tmpdir(), { interactive: true })
    ).resolves.toBe(resolved);
    expect(navigateCatalog).toHaveBeenCalledWith(manifest, tmpdir());
  });
});

describe('registrySourceLabel', () => {
  it('returns "built-in" for undefined source', () => {
    expect(registrySourceLabel(undefined)).toBe('built-in');
  });

  it('returns "built-in" for "bundled" sentinel', () => {
    expect(registrySourceLabel('bundled')).toBe('built-in');
  });

  it('passes through registry name for non-bundled sources', () => {
    expect(registrySourceLabel('team-templates')).toBe('team-templates');
  });

  it('passes through file paths from project/global registries', () => {
    expect(
      registrySourceLabel('/home/user/.rayfin/template-registries.yml')
    ).toBe('/home/user/.rayfin/template-registries.yml');
  });
});
