import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cliUserInteraction } from '../adapters/user-interaction.js';
import { runDevV2 } from '../commands/dev/dev-v2.js';
import { dev, isDevMaintenanceAction } from '../commands/dev/dev.js';
import { isInteractive } from '../utils/output-mode.js';

const dockerMocks = vi.hoisted(() => ({
  purgeDockerServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../commands/dev/dev-v2.js', () => ({
  runDevV2: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../adapters/user-interaction.js', () => ({
  cliUserInteraction: { confirm: vi.fn(), prompt: vi.fn(), select: vi.fn() },
}));
vi.mock('../utils/output-mode.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/output-mode.js')>()),
  isInteractive: vi.fn(() => false),
}));
vi.mock('../utils/docker-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/docker-utils.js')>()),
  checkDockerAvailable: vi.fn(() => ({ available: true, version: 'test' })),
  checkDockerComposeAvailable: vi.fn(() => ({
    available: true,
    command: 'docker compose',
    version: 'test',
  })),
  purgeDockerServices: dockerMocks.purgeDockerServices,
}));
vi.mock('../utils/docker-compose-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/docker-compose-utils.js')>()),
  copyOrOverwriteDockerComposeFile: vi.fn().mockResolvedValue({
    path: '/tmp/docker-compose.yml',
    updated: false,
  }),
  extractProfilesFromComposeFile: vi.fn().mockResolvedValue(['telemetry']),
}));
vi.mock('../local-services/dev/docker-lifecycle.js', async (importActual) => ({
  ...(await importActual<
    typeof import('../local-services/dev/docker-lifecycle.js')
  >()),
  resolveDockerComposeOverrides: vi.fn(() => ({
    additionalComposePaths: [],
    projectDirectory: undefined,
  })),
}));

describe('dev command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.purgeDockerServices.mockResolvedValue(undefined);
    vi.mocked(isInteractive).mockReturnValue(false);
  });

  it('describes the default local development session', () => {
    const command = dev();

    expect(command.name()).toBe('dev');
    expect(command.description()).toBe(
      'Start a local development session against a Rayfin backend'
    );
    expect(command.registeredArguments[0].name()).toBe('project-path');
    expect(command.registeredArguments[0].required).toBe(false);
  });

  it('documents Fabric as the default provider without preview wording', () => {
    const provider = dev().options.find(
      (option) => option.long === '--provider'
    );

    expect(provider?.defaultValue).toBe('fabric');
    expect(provider?.description).toContain('defaults to fabric');
    expect(provider?.description).not.toContain('tools-arch-v2');
  });

  it('exposes Fabric tenant and keychain fallback options', () => {
    const options = dev().options;

    expect(options.find((option) => option.long === '--tenant')?.short).toBe(
      '-t'
    );
    expect(
      options.find((option) => option.long === '--capacity-id')?.attributeName()
    ).toBe('capacityId');
    expect(
      options.find((option) => option.long === '--encryption-fallback-enabled')
        ?.description
    ).toContain('keychain error');
  });

  it('does not expose legacy start-session options', () => {
    const optionNames = dev().options.map((option) => option.long);

    expect(optionNames).not.toContain('--detach');
    expect(optionNames).not.toContain('--pull');
    expect(optionNames).not.toContain('--health-timeout');
    expect(optionNames).not.toContain('--debug');
  });

  it('routes bare dev to the workflow with the Fabric provider by default', async () => {
    const command = dev(process.cwd(), {
      processEnv: { ...process.env, RAYFIN_FEATURE_FLAGS: '' },
    });

    await command.parseAsync(['node', 'rayfin']);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ provider: 'fabric' })
    );
  });

  it('routes an explicit Fabric provider to the workflow', async () => {
    const command = dev();

    await command.parseAsync(['node', 'rayfin', '--provider', 'fabric']);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ provider: 'fabric' })
    );
  });

  it('forwards --capacity-id as the normalized capacityId option', async () => {
    const command = dev();
    const capacityId = '11111111-1111-4111-8111-111111111111';

    await command.parseAsync(['node', 'rayfin', '--capacity-id', capacityId]);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ capacityId })
    );
  });

  it('routes an explicit Docker provider to the workflow for availability validation', async () => {
    const command = dev();

    await command.parseAsync(['node', 'rayfin', '--provider', 'docker']);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ provider: 'docker' })
    );
  });

  it('forwards --skip-db-apply to the workflow request', async () => {
    const command = dev();

    await command.parseAsync(['node', 'rayfin', '--skip-db-apply']);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ skipDataApply: true })
    );
  });

  it('forwards the root --yes option to the workflow wrapper', async () => {
    const program = new Command().option('-y, --yes');
    program.addCommand(dev());

    await program.parseAsync(['node', 'rayfin', '--yes', 'dev']);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ yes: true })
    );
  });

  it.each(['--stop', '--down', '--export-env'])(
    'retains %s on the Docker maintenance path',
    async (flag) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const command = dev(process.cwd(), {
        processEnv: { ...process.env, RAYFIN_FEATURE_FLAGS: '' },
      });

      await expect(
        command.parseAsync(['node', 'rayfin', flag])
      ).rejects.toThrow('Docker maintenance actions are not available.');

      expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
    }
  );

  it('executes --export-env from a project path containing spaces', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rayfin dev maintenance '));
    const rayfinDir = join(projectRoot, 'rayfin');
    mkdirSync(rayfinDir);
    writeFileSync(
      join(rayfinDir, 'rayfin.yml'),
      'id: maintenance-test\nservices: {}\n'
    );
    writeFileSync(
      join(rayfinDir, '.env'),
      '# Rayfin environment configuration\nMAINTENANCE_VALUE=ready\n'
    );
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const command = dev(process.cwd(), {
        dockerMaintenanceEnabled: true,
        processEnv: {
          ...process.env,
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      });

      await command.parseAsync(['node', 'rayfin', projectRoot, '--export-env']);

      expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
      expect(writes.join('')).toContain('MAINTENANCE_VALUE=ready');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('loads maintenance config through --env-file interpolation', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-dev-env-file-'));
    const rayfinDir = join(projectRoot, 'rayfin');
    mkdirSync(rayfinDir);
    writeFileSync(
      join(rayfinDir, 'rayfin.yml'),
      'id: ${PROJECT_ID}\nservices: {}\n'
    );
    writeFileSync(join(rayfinDir, '.env.custom'), 'PROJECT_ID=from-env\n');
    writeFileSync(join(rayfinDir, '.env'), 'MAINTENANCE_VALUE=ready\n');

    try {
      const command = dev(process.cwd(), {
        dockerMaintenanceEnabled: true,
        processEnv: {
          ...process.env,
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      });
      await command.parseAsync([
        'node',
        'rayfin',
        projectRoot,
        '--export-env',
        '--env-file',
        'rayfin/.env.custom',
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('forwards confirmed session purge to the Docker workflow', async () => {
    const program = new Command().option('-y, --yes');
    program.addCommand(
      dev(process.cwd(), {
        processEnv: {
          ...process.env,
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      })
    );

    await program.parseAsync([
      'node',
      'rayfin',
      '--yes',
      'dev',
      '--provider',
      'docker',
      '--purge',
    ]);

    expect(vi.mocked(runDevV2)).toHaveBeenCalledWith(
      '.',
      expect.objectContaining({ provider: 'docker', purge: true, yes: true })
    );
  });

  it('rejects non-interactive session purge without --yes', async () => {
    const command = dev(process.cwd(), {
      processEnv: {
        ...process.env,
        CI: 'true',
        RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
      },
    });

    await expect(
      command.parseAsync(['node', 'rayfin', '--provider', 'docker', '--purge'])
    ).rejects.toThrow('requires confirmation');
    expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
  });

  it('emits one JSON error without prompting for unconfirmed purge', async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const program = new Command().option('--json');
    program.addCommand(dev());

    try {
      await expect(
        program.parseAsync([
          'node',
          'rayfin',
          '--json',
          'dev',
          '--provider',
          'docker',
          '--purge',
        ])
      ).rejects.toThrow('requires confirmation');

      const writes = stdout.mock.calls.map((call) => String(call[0]));
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])).toEqual({
        status: 'error',
        error: 'Purge requires confirmation in non-interactive mode.',
        hint: 'Re-run with `--yes` to confirm permanent data loss.',
      });
      expect(isInteractive).not.toHaveBeenCalled();
      expect(cliUserInteraction.confirm).not.toHaveBeenCalled();
      expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it.each([
    {
      name: 'an incompatible maintenance flag',
      args: ['--stop', '--purge'],
      error: '`--purge` cannot be combined with `--stop` or `--export-env`.',
      hint: 'Use `--down --purge` for immediate cleanup, or `--provider docker --purge` for session teardown.',
    },
    {
      name: 'the Fabric provider',
      args: ['--purge'],
      error: '`--purge` requires `--provider docker`.',
      hint: 'Re-run with `--provider docker --purge`, or omit `--purge` for Fabric.',
    },
  ])('emits one JSON error for $name', async ({ args, error, hint }) => {
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const program = new Command().option('--json');
    program.addCommand(dev());

    try {
      await expect(
        program.parseAsync(['node', 'rayfin', '--json', 'dev', ...args])
      ).rejects.toThrow(error);

      const writes = stdout.mock.calls.map((call) => String(call[0]));
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])).toEqual({
        status: 'error',
        error,
        hint,
      });
      expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it('runs --down --purge as immediate confirmed maintenance', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rayfin-dev-purge-'));
    const rayfinDir = join(projectRoot, 'rayfin');
    mkdirSync(rayfinDir);
    writeFileSync(
      join(rayfinDir, 'rayfin.yml'),
      'id: maintenance-test\nservices: {}\n'
    );
    const program = new Command().option('-y, --yes');
    program.addCommand(
      dev(projectRoot, {
        dockerMaintenanceEnabled: true,
        processEnv: {
          ...process.env,
          RAYFIN_FEATURE_FLAGS: 'docker-local-dev',
        },
      })
    );

    try {
      await program.parseAsync([
        'node',
        'rayfin',
        '--yes',
        'dev',
        projectRoot,
        '--down',
        '--purge',
      ]);

      expect(dockerMocks.purgeDockerServices).toHaveBeenCalledOnce();
      expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each(['--stop', '--export-env'])(
    'rejects --purge combined with %s',
    async (flag) => {
      const command = dev();
      await expect(
        command.parseAsync(['node', 'rayfin', flag, '--purge'])
      ).rejects.toThrow('cannot be combined');
      expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
    }
  );

  it('rejects session purge without the Docker provider', async () => {
    const command = dev();
    await expect(
      command.parseAsync(['node', 'rayfin', '--purge'])
    ).rejects.toThrow('requires `--provider docker`');
    expect(vi.mocked(runDevV2)).not.toHaveBeenCalled();
  });

  it('keeps standalone --purge off the maintenance path', () => {
    expect(
      isDevMaintenanceAction({ stop: false, down: false, exportEnv: false })
    ).toBe(false);
  });
});
