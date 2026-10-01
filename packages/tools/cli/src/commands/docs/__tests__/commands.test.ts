/**
 * End-to-end tests for the three `rayfin docs` subcommands. We inject a stub
 * `DocsService` so we don't depend on the real docs corpus actually being
 * present at test time (the CLI package consumes the public docs service,
 * which discovers docs from installed packages at runtime).
 *
 * The stub mirrors the public methods used by the CLI: `listDocs`, `searchDocs`,
 * `getDocById`, `getDocsByPath`, `getSymbolDocs`. Each is asserted-on directly
 * by individual test cases so we lock the contract between the CLI and the
 * `DocsService` surface in `@microsoft/rayfin-docs`.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock output-mode so emitJson goes through console.log (tests spy on it).
// Mirrors the pattern in up-status.test.ts.
vi.mock('../../../utils/output-mode', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/output-mode')>();
  return {
    ...actual,
    emitJson: (data: Record<string, unknown>) =>
      console.log(JSON.stringify(data, null, 2)),
  };
});

import { CliHandledError } from '../../../errors.js';
import { createDocsCommand } from '../docs.js';
import {
  resetDocsServiceForTesting,
  setDocsServiceForTesting,
} from '../helpers.js';

interface StubService {
  listDocs: ReturnType<typeof vi.fn>;
  searchDocs: ReturnType<typeof vi.fn>;
  getDocById: ReturnType<typeof vi.fn>;
  getDocsByPath: ReturnType<typeof vi.fn>;
  getSymbolDocs: ReturnType<typeof vi.fn>;
}

function makeStub(): StubService {
  return {
    listDocs: vi.fn(),
    searchDocs: vi.fn(),
    getDocById: vi.fn(),
    getDocsByPath: vi.fn(),
    getSymbolDocs: vi.fn(),
  };
}

function setNonInteractive(): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });
}

/**
 * Run the CLI with a fresh `docs` command tree. Each test gets an isolated
 * Commander instance so option state from prior runs doesn't leak.
 */
async function runCli(argv: string[]): Promise<void> {
  const cmd = createDocsCommand();
  await cmd.parseAsync(argv, { from: 'user' });
}

/** Run through a tiny root command so root-level `--json` inheritance is tested. */
async function runRootCli(argv: string[]): Promise<void> {
  const root = new Command('rayfin')
    .exitOverride()
    .option('--json', 'Emit machine-readable JSON output', false)
    .addCommand(createDocsCommand());
  await root.parseAsync(argv, { from: 'user' });
}

function lastJson(
  logSpy: ReturnType<typeof vi.spyOn>
): Record<string, unknown> {
  // Find the last log call whose arg parses as JSON. The test-mocked emitJson
  // logs JSON.stringify(data); other modeLog calls emit human text.
  const calls = logSpy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const arg = calls[i]?.[0];
    if (typeof arg === 'string' && arg.startsWith('{')) {
      try {
        return JSON.parse(arg) as Record<string, unknown>;
      } catch {
        // not JSON; keep scanning
      }
    }
  }
  throw new Error(
    `No JSON log call found in ${calls.length} captured log calls.`
  );
}

describe('rayfin docs list', () => {
  let stub: StubService;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stub = makeStub();
    setDocsServiceForTesting(
      stub as unknown as Parameters<typeof setDocsServiceForTesting>[0]
    );
    setNonInteractive();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetDocsServiceForTesting();
    vi.restoreAllMocks();
  });

  it('emits a JSON envelope with status, schemaVersion, count, items', async () => {
    stub.listDocs.mockReturnValue([
      {
        id: 'guide:guide/index.md',
        module: 'guide',
        path: 'guide/index.md',
        title: 'Overview',
      },
      {
        id: 'guide:guide/data/overview.md',
        module: 'guide',
        path: 'guide/data/overview.md',
        title: 'Data overview',
      },
    ]);

    await runCli(['list', '--json']);

    const json = lastJson(logSpy);
    expect(json.status).toBe('ok');
    expect(json.schemaVersion).toBe(1);
    expect(json.module).toBeNull();
    expect(json.count).toBe(2);
    expect(json.items).toHaveLength(2);
    expect(stub.listDocs).toHaveBeenCalledWith(undefined);
  });

  it('honors root-level `rayfin --json docs list`', async () => {
    stub.listDocs.mockReturnValue([]);

    await runRootCli(['--json', 'docs', 'list']);

    const json = lastJson(logSpy);
    expect(json.status).toBe('ok');
    expect(json.schemaVersion).toBe(1);
    expect(json.count).toBe(0);
    expect(json.items).toEqual([]);
  });

  it('passes --module through to listDocs and reflects it in the envelope', async () => {
    stub.listDocs.mockReturnValue([]);

    await runCli(['list', '--module', 'ts-sdk', '--json']);

    expect(stub.listDocs).toHaveBeenCalledWith('ts-sdk');
    const json = lastJson(logSpy);
    expect(json.module).toBe('ts-sdk');
    expect(json.count).toBe(0);
  });

  it('rejects an unknown --module with CliHandledError', async () => {
    await expect(runCli(['list', '--module', 'cli', '--json'])).rejects.toThrow(
      CliHandledError
    );
    expect(stub.listDocs).not.toHaveBeenCalled();
  });
});

describe('rayfin docs search', () => {
  let stub: StubService;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stub = makeStub();
    setDocsServiceForTesting(
      stub as unknown as Parameters<typeof setDocsServiceForTesting>[0]
    );
    setNonInteractive();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetDocsServiceForTesting();
    vi.restoreAllMocks();
  });

  it('forwards query, module, scope, and limit; emits stable JSON envelope', async () => {
    stub.searchDocs.mockReturnValue([
      {
        id: 'guide:guide/auth/overview.md',
        module: 'guide',
        path: 'guide/auth/overview.md',
        title: 'Auth overview',
        snippet: 'magic link flow ...',
        snippetStart: 0,
        snippetEnd: 10,
        score: 4.2,
        symbols: ['sendMagicLink'],
        kind: 'doc',
      },
    ]);

    await runCli([
      'search',
      'magic link',
      '--module',
      'guide',
      '--scope',
      'all',
      '--limit',
      '5',
      '--json',
    ]);

    expect(stub.searchDocs).toHaveBeenCalledWith(
      'magic link',
      'guide',
      5,
      'all'
    );
    const json = lastJson(logSpy);
    expect(json.status).toBe('ok');
    expect(json.schemaVersion).toBe(1);
    expect(json.query).toBe('magic link');
    expect(json.module).toBe('guide');
    expect(json.scope).toBe('all');
    expect(json.limit).toBe(5);
    expect(json.count).toBe(1);
    expect(json.results).toHaveLength(1);
  });

  it('defaults limit to 10 and scope to docs when flags are absent', async () => {
    stub.searchDocs.mockReturnValue([]);

    await runCli(['search', 'foo', '--json']);

    expect(stub.searchDocs).toHaveBeenCalledWith('foo', undefined, 10, 'docs');
  });

  it('rejects --limit out of range', async () => {
    await expect(
      runCli(['search', 'foo', '--limit', '99', '--json'])
    ).rejects.toThrow(CliHandledError);
    expect(stub.searchDocs).not.toHaveBeenCalled();
  });

  it('rejects an unknown --scope', async () => {
    await expect(
      runCli(['search', 'foo', '--scope', 'everything', '--json'])
    ).rejects.toThrow(CliHandledError);
    expect(stub.searchDocs).not.toHaveBeenCalled();
  });
});

describe('rayfin docs get', () => {
  let stub: StubService;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stub = makeStub();
    setDocsServiceForTesting(
      stub as unknown as Parameters<typeof setDocsServiceForTesting>[0]
    );
    setNonInteractive();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetDocsServiceForTesting();
    vi.restoreAllMocks();
  });

  it('fetches by id and emits the entry inside the standard envelope', async () => {
    const entry = {
      id: 'guide:guide/data/overview.md',
      module: 'guide',
      path: 'guide/data/overview.md',
      title: 'Data overview',
      content: '# Data overview\n\nBody.',
      symbols: ['@entity', '@one'],
      sections: [],
    };
    stub.getDocById.mockReturnValue(entry);

    await runCli(['get', '--id', 'guide:guide/data/overview.md', '--json']);

    expect(stub.getDocById).toHaveBeenCalledWith(
      'guide:guide/data/overview.md'
    );
    const json = lastJson(logSpy);
    expect(json.status).toBe('ok');
    expect(json.schemaVersion).toBe(1);
    expect(json.entry).toEqual(entry);
  });

  it('fetches by path', async () => {
    stub.getDocsByPath.mockReturnValue([
      {
        id: 'guide:guide/auth/overview.md',
        module: 'guide',
        path: 'guide/auth/overview.md',
        title: 'Auth',
        content: '#',
        symbols: [],
        sections: [],
      },
    ]);

    await runCli(['get', '--path', 'guide/auth/overview.md', '--json']);

    expect(stub.getDocsByPath).toHaveBeenCalledWith(
      'guide/auth/overview.md',
      undefined
    );
  });

  it('rejects ambiguous path lookups with candidate ids', async () => {
    stub.getDocsByPath.mockReturnValue([
      {
        id: 'rayfin-core:index.md',
        module: 'ts-sdk',
        path: 'index.md',
        title: 'Core',
        content: '#',
        symbols: [],
        sections: [],
      },
      {
        id: 'rayfin-data:index.md',
        module: 'ts-sdk',
        path: 'index.md',
        title: 'Data',
        content: '#',
        symbols: [],
        sections: [],
      },
    ]);

    await expect(
      runCli(['get', '--path', 'index.md', '--json'])
    ).rejects.toThrow(CliHandledError);

    const json = lastJson(logSpy);
    expect(json.status).toBe('error');
    expect(json.error).toContain('ambiguous');
    expect(json.error).toContain('rayfin-core:index.md');
    expect(json.error).toContain('rayfin-data:index.md');
  });

  it('passes --module to path disambiguation', async () => {
    stub.getDocsByPath.mockReturnValue([
      {
        id: 'guide:guide/auth/overview.md',
        module: 'guide',
        path: 'guide/auth/overview.md',
        title: 'Auth',
        content: '#',
        symbols: [],
        sections: [],
      },
    ]);

    await runCli([
      'get',
      '--path',
      'guide/auth/overview.md',
      '--module',
      'guide',
      '--json',
    ]);

    expect(stub.getDocsByPath).toHaveBeenCalledWith(
      'guide/auth/overview.md',
      'guide'
    );
  });

  it('resolves symbols and reflects --module + --limit in the envelope', async () => {
    stub.getSymbolDocs.mockReturnValue([
      {
        symbol: 'RayfinClient',
        entryId: 'ts-sdk:ts-sdk/rayfin-client/index.md',
        module: 'ts-sdk',
        path: 'ts-sdk/rayfin-client/index.md',
        title: 'RayfinClient',
        heading: 'class RayfinClient',
        content: 'A client...',
      },
      {
        symbol: 'RayfinClient',
        entryId: 'guide:guide/data/graphql.md',
        module: 'guide',
        path: 'guide/data/graphql.md',
        title: 'GraphQL',
        heading: 'Setup',
        content: 'Construct...',
      },
    ]);

    await runCli([
      'get',
      '--symbol',
      'RayfinClient',
      '--module',
      'ts-sdk',
      '--limit',
      '1',
      '--json',
    ]);

    expect(stub.getSymbolDocs).toHaveBeenCalledWith('RayfinClient', 'ts-sdk');
    const json = lastJson(logSpy);
    expect(json.symbol).toBe('RayfinClient');
    expect(json.module).toBe('ts-sdk');
    expect(json.count).toBe(1);
    expect(json.sections as unknown[]).toHaveLength(1);
  });

  it('errors when no lookup arg is provided', async () => {
    await expect(runCli(['get', '--json'])).rejects.toThrow(CliHandledError);
    expect(stub.getDocById).not.toHaveBeenCalled();
    expect(stub.getDocsByPath).not.toHaveBeenCalled();
    expect(stub.getSymbolDocs).not.toHaveBeenCalled();
  });

  it('errors when more than one lookup arg is provided', async () => {
    await expect(
      runCli(['get', '--id', 'a', '--path', 'b', '--json'])
    ).rejects.toThrow(CliHandledError);
  });

  it('errors with a fix-it hint when the id is not found', async () => {
    stub.getDocById.mockReturnValue(undefined);

    await expect(
      runCli(['get', '--id', 'guide:does/not/exist.md', '--json'])
    ).rejects.toThrow(CliHandledError);

    // JSON error envelope is emitted to stdout before the throw so machine
    // consumers see structured failure context. The throw still propagates a
    // non-zero exit code via CliHandledError.
    const json = lastJson(logSpy);
    expect(json.status).toBe('error');
    expect(json.schemaVersion).toBe(1);
    expect(json.error).toContain("id 'guide:does/not/exist.md'");
  });
});

describe('rayfin docs catalog show', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setNonInteractive();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the catalog inside the standard JSON envelope', async () => {
    await runCli(['catalog', 'show', '--json']);

    const json = lastJson(logSpy);
    expect(json.status).toBe('ok');
    expect(json.schemaVersion).toBe(1);
    expect(json.catalog).toEqual(
      expect.objectContaining({
        schemaVersion: expect.any(Number),
        packages: expect.any(Array),
      })
    );
    expect(json.count).toBe(
      (json.catalog as { packages: unknown[] }).packages.length
    );
  });

  it('emits compact catalog JSON in lean mode', async () => {
    await runCli(['catalog', 'show', '--lean']);

    const json = lastJson(logSpy);
    expect(json).not.toHaveProperty('status');
    expect(json).not.toHaveProperty('schemaVersion');
    expect(json.catalog).toEqual(
      expect.objectContaining({
        packages: expect.any(Array),
      })
    );
    expect(json.count).toBe(
      (json.catalog as { packages: unknown[] }).packages.length
    );
  });

  it('emits a human-readable catalog summary by default', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await runCli(['catalog', 'show']);

    expect(logSpy).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Catalog (schema v');
    expect(output).toContain('Total packages:');
  });
});

describe('rayfin docs discover', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setNonInteractive();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits recommendations inside the standard JSON envelope', async () => {
    await runCli(['discover', 'core', '--json', '--limit', '1']);

    const json = lastJson(logSpy);
    expect(json.status).toBe('ok');
    expect(json.schemaVersion).toBe(1);
    expect(json.query).toBe('core');
    expect(json.count).toBe(1);
    expect(json.total).toEqual(expect.any(Number));
    expect(json.items).toEqual([
      expect.objectContaining({
        name: expect.any(String),
        installCommand: expect.any(String),
      }),
    ]);
  });

  it('preserves total in lean mode so agents can detect truncation', async () => {
    await runCli(['discover', 'core', '--lean', '--limit', '1']);

    const json = lastJson(logSpy);
    expect(json).not.toHaveProperty('status');
    expect(json.query).toBe('core');
    expect(json.total).toEqual(expect.any(Number));
    expect(json.items).toHaveLength(1);
  });

  it('supports the -l short limit flag', async () => {
    await runCli(['discover', 'rayfin', '--json', '-l', '1']);

    const json = lastJson(logSpy);
    expect(json.count).toBe(1);
  });

  it('rejects --limit out of range', async () => {
    await expect(
      runCli(['discover', 'core', '--json', '--limit', '99'])
    ).rejects.toThrow(CliHandledError);
  });
});
