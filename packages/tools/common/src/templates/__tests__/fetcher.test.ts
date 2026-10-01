import { execFile } from 'child_process';
import { mkdtemp, open, rm } from 'fs/promises';
import { join } from 'path';

import * as tar from 'tar';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process.execFile before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises for mkdtemp and rm
vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mkdtemp: vi.fn(),
    open: vi.fn(),
    rm: vi.fn(),
  };
});

vi.mock('tar', () => ({
  x: vi.fn(),
}));

import { fetchTemplate, ensureGitAvailable } from '../git/fetcher';

// Helper to make execFile resolve or reject
function mockExecFileSuccess() {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      // promisify calls with (cmd, args, opts) and returns a promise
      // but execFile is callback-based — promisify wraps it
      if (cb) {
        cb(null, '', '');
      }
    }
  );
}

function mockExecFileError(message: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      if (cb) {
        cb(new Error(message));
      }
    }
  );
}

describe('ensureGitAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves when git is available', async () => {
    mockExecFileSuccess();
    await expect(ensureGitAvailable()).resolves.toBeUndefined();
  });

  it('throws when git is not on PATH', async () => {
    mockExecFileError('ENOENT');
    await expect(ensureGitAvailable()).rejects.toThrow(
      'git is not available on PATH'
    );
  });
});

describe('fetchTemplate', () => {
  const TEMP_DIR = join('/tmp', 'rayfin-template-abc123');
  const ARCHIVE_DIR = join('/tmp', 'rayfin-template-archive-abc123');
  const ARCHIVE_PATH = join(ARCHIVE_DIR, 'template.tar.gz');
  let fetchMock: ReturnType<typeof vi.fn>;
  let archiveFile: {
    write: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (mkdtemp as ReturnType<typeof vi.fn>).mockImplementation(
      async (prefix: string) =>
        prefix.includes('rayfin-template-archive-') ? ARCHIVE_DIR : TEMP_DIR
    );
    archiveFile = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(archiveFile);
    (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    vi.mocked(tar.x).mockResolvedValue(undefined);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockArchiveResponse(body = 'archive') {
    const bytes = new TextEncoder().encode(body);
    fetchMock.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-length': String(bytes.byteLength) },
      })
    );
  }

  it('clones successfully and returns temp directory', async () => {
    mockExecFileSuccess();

    const result = await fetchTemplate({
      url: 'https://github.com/org/repo.git',
    });

    expect(result).toBe(TEMP_DIR);
    // Verify clone args include --depth 1, --single-branch, and --
    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1]; // [0] = ensureGitAvailable, [1] = clone
    const args = call[1] as string[];
    expect(args).toContain('--depth');
    expect(args).toContain('1');
    expect(args).toContain('--single-branch');
    expect(args).toContain('--');
    expect(args).toContain('https://github.com/org/repo.git');
    expect(args).toContain(TEMP_DIR);
  });

  it('adds --branch when ref is provided', async () => {
    mockExecFileSuccess();

    await fetchTemplate({
      url: 'https://github.com/org/repo.git',
      ref: 'v1.0.0',
    });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const args = call[1] as string[];
    expect(args).toContain('--branch');
    expect(args).toContain('v1.0.0');
  });

  it('strips refs/tags/ prefix before passing to --branch', async () => {
    mockExecFileSuccess();

    await fetchTemplate({
      url: 'https://github.com/org/repo.git',
      ref: 'refs/tags/v1',
    });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const args = call[1] as string[];
    const branchIdx = args.indexOf('--branch');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(args[branchIdx + 1]).toBe('v1');
    expect(args).not.toContain('refs/tags/v1');
  });

  it('strips refs/heads/ prefix before passing to --branch', async () => {
    mockExecFileSuccess();

    await fetchTemplate({
      url: 'https://github.com/org/repo.git',
      ref: 'refs/heads/main',
    });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const args = call[1] as string[];
    const branchIdx = args.indexOf('--branch');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(args[branchIdx + 1]).toBe('main');
    expect(args).not.toContain('refs/heads/main');
  });

  it('clones floating major tags via --branch (not the SHA path)', async () => {
    // Floating-major tags (e.g. `v1` that upstream maintains as a pointer to
    // the latest v1.x.y release) must go through the lightweight single-branch
    // clone path - NOT the SHA path (which uses an additional `git fetch` +
    // `git checkout --detach`). The SHA path defeats `--depth 1` benefits
    // because it can't resolve a tag name.
    mockExecFileSuccess();

    await fetchTemplate({
      url: 'https://github.com/org/repo.git',
      ref: 'v1',
    });

    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // calls[0] is the `git --version` availability check.
    const cloneArgs = calls[1][1] as string[];
    expect(cloneArgs).toContain('clone');
    expect(cloneArgs).toContain('--depth');
    expect(cloneArgs).toContain('1');
    expect(cloneArgs).toContain('--single-branch');
    const branchIdx = cloneArgs.indexOf('--branch');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(cloneArgs[branchIdx + 1]).toBe('v1');

    // The SHA path's second/third calls (`fetch origin <sha>` and
    // `checkout --detach <sha>`) must NOT fire for tag refs.
    const followUpCalls = calls
      .slice(2)
      .map((c) => (c[1] as string[]).join(' '));
    expect(followUpCalls.some((c) => c.includes('fetch'))).toBe(false);
    expect(followUpCalls.some((c) => c.includes('checkout'))).toBe(false);
  });

  it.each([['refs/tags/'], ['refs/heads/']])(
    'stripQualifiedRefPrefix throws on empty-tail input %s',
    async (ref) => {
      const { stripQualifiedRefPrefix } = await import('../git/fetcher');
      expect(() => stripQualifiedRefPrefix(ref)).toThrow(
        /qualified refs must have a non-empty tail/
      );
    }
  );

  it.each([
    ['refs/tags/-rf'],
    ['refs/tags/--upload-pack=evil'],
    ['refs/tags/568c87f'],
    ['refs/heads/-rf'],
    ['refs/heads/deadbeef'],
  ])(
    'fetchTemplate rejects malformed-tail qualified refs (%s) so they cannot reach git clone --branch',
    async (ref) => {
      mockExecFileSuccess();

      // This is the end-to-end guarantee: malformed-tail qualified refs are
      // rejected at the stripQualifiedRefPrefix boundary BEFORE git clone is
      // invoked with the bad tail. Mirrors parseGitUrl's rejection of the
      // same shapes in unqualified form.
      await expect(
        fetchTemplate({ url: 'https://github.com/org/repo.git', ref })
      ).rejects.toThrow(/fails the short-ref-name shape check/);

      // No clone call must have fired with the malformed tail.
      const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock
        .calls;
      const cloneCall = calls.find((c) => (c[1] as string[]).includes('clone'));
      expect(cloneCall).toBeUndefined();
    }
  );

  it('fetches and checks out full commit SHA refs', async () => {
    mockExecFileSuccess();
    const sha = 'abc1234567890abc1234567890abc1234567890a';

    await fetchTemplate({
      url: 'https://github.com/org/repo.git',
      ref: sha,
    });

    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const cloneArgs = calls[1][1] as string[];
    expect(cloneArgs).not.toContain('--branch');
    expect(cloneArgs).not.toContain('--single-branch');
    expect(calls[2][1]).toEqual([
      '-C',
      TEMP_DIR,
      'fetch',
      '--depth',
      '1',
      'origin',
      sha,
    ]);
    expect(calls[3][1]).toEqual(['-C', TEMP_DIR, 'checkout', '--detach', sha]);
  });

  it('omits --branch when no ref', async () => {
    mockExecFileSuccess();

    await fetchTemplate({ url: 'https://github.com/org/repo.git' });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const args = call[1] as string[];
    expect(args).not.toContain('--branch');
  });

  it('sets GIT_TERMINAL_PROMPT=0 to disable interactive prompts', async () => {
    mockExecFileSuccess();

    await fetchTemplate({ url: 'https://github.com/org/repo.git' });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const opts = call[2] as { env: Record<string, string> };
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('falls back to GitHub archives when git is unavailable', async () => {
    mockExecFileError('ENOENT');
    mockArchiveResponse();
    const sha = 'abc1234567890abc1234567890abc1234567890a';

    const onArchiveFallback = vi.fn();

    const result = await fetchTemplate(
      {
        url: 'https://github.com/org/repo.git',
        ref: sha,
      },
      { onArchiveFallback }
    );

    expect(result).toBe(TEMP_DIR);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://github.com/org/repo/archive/${sha}.tar.gz`,
      expect.objectContaining({
        headers: { 'User-Agent': 'rayfin-cli' },
        redirect: 'follow',
      })
    );
    expect(open).toHaveBeenCalledWith(ARCHIVE_PATH, 'w');
    expect(archiveFile.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(archiveFile.close).toHaveBeenCalled();
    expect(tar.x).toHaveBeenCalledWith(
      expect.objectContaining({
        file: ARCHIVE_PATH,
        cwd: TEMP_DIR,
        strip: 1,
        strict: true,
      })
    );
    expect(onArchiveFallback).toHaveBeenCalledWith(
      expect.stringContaining('commit SHA verification is unavailable')
    );
    expect(rm).toHaveBeenCalledWith(ARCHIVE_DIR, {
      recursive: true,
      force: true,
    });
    expect(rm).not.toHaveBeenCalledWith(TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });

  it('keeps the downloaded archive outside the extraction directory', async () => {
    mockExecFileError('ENOENT');
    mockArchiveResponse();

    await fetchTemplate({ url: 'https://github.com/org/repo.git' });

    expect(open).toHaveBeenCalledWith(ARCHIVE_PATH, 'w');
    expect(tar.x).toHaveBeenCalledWith(
      expect.objectContaining({
        file: ARCHIVE_PATH,
        cwd: TEMP_DIR,
      })
    );
    expect(ARCHIVE_PATH.startsWith(TEMP_DIR)).toBe(false);
  });

  it('uses HEAD for GitHub archive fallback when no ref is provided', async () => {
    mockExecFileError('ENOENT');
    mockArchiveResponse();

    await fetchTemplate({ url: 'https://github.com/org/repo' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/org/repo/archive/HEAD.tar.gz',
      expect.anything()
    );
  });

  it('requires git when git is unavailable and the source is not a GitHub HTTPS repo', async () => {
    mockExecFileError('ENOENT');

    await expect(
      fetchTemplate({ url: 'git@github.com:org/private-repo.git' })
    ).rejects.toThrow(
      'Git is required for malformed GitHub URLs, GitHub Enterprise, non-GitHub, SSH, or private repository templates'
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });

  it('explains the supported no-git GitHub URL shape for malformed GitHub URLs', async () => {
    mockExecFileError('ENOENT');

    await expect(
      fetchTemplate({ url: 'https://github.com/org/repo/tree/main' })
    ).rejects.toThrow('https://github.com/<owner>/<repo>[.git]');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports that git is required for private repositories when archive download is unavailable', async () => {
    mockExecFileError('ENOENT');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
    } as Response);

    await expect(
      fetchTemplate({ url: 'https://github.com/org/private-repo.git' })
    ).rejects.toThrow(
      'Git is required to use templates from private repositories'
    );

    expect(rm).toHaveBeenCalledWith(TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });

  it('cleans up the temp directory when archive extraction fails', async () => {
    mockExecFileError('ENOENT');
    mockArchiveResponse();
    vi.mocked(tar.x).mockRejectedValue(new Error('bad archive'));

    await expect(
      fetchTemplate({ url: 'https://github.com/org/repo.git' })
    ).rejects.toThrow('bad archive');

    expect(rm).toHaveBeenCalledWith(TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });

  it('rejects unsafe paths and links in GitHub archive entries', async () => {
    mockExecFileError('ENOENT');
    mockArchiveResponse();

    await fetchTemplate({ url: 'https://github.com/org/repo.git' });

    const options = vi.mocked(tar.x).mock.calls[0][0] as {
      filter: (
        entryPath: string,
        entry: { type: string; size?: number }
      ) => boolean;
    };
    expect(options.filter('repo-main/src/index.ts', { type: 'File' })).toBe(
      true
    );
    expect(() =>
      options.filter('repo-main/../evil.txt', { type: 'File' })
    ).toThrow('Unsafe path');
    expect(() =>
      options.filter('repo-main/link', { type: 'SymbolicLink' })
    ).toThrow('Unsupported link');
  });

  it('rejects GitHub archives that exceed the extracted size cap', async () => {
    mockExecFileError('ENOENT');
    mockArchiveResponse();

    await fetchTemplate({ url: 'https://github.com/org/repo.git' });

    const options = vi.mocked(tar.x).mock.calls[0][0] as {
      filter: (
        entryPath: string,
        entry: { type: string; size?: number }
      ) => boolean;
    };

    expect(
      options.filter('repo-main/large.bin', {
        type: 'File',
        size: 500 * 1024 * 1024,
      })
    ).toBe(true);
    expect(() =>
      options.filter('repo-main/too-large.bin', { type: 'File', size: 1 })
    ).toThrow('expands beyond');
  });

  it('times out GitHub archive extraction', async () => {
    vi.useFakeTimers();
    try {
      mockExecFileError('ENOENT');
      mockArchiveResponse();
      vi.mocked(tar.x).mockReturnValue(new Promise(() => undefined));

      const result = fetchTemplate({ url: 'https://github.com/org/repo.git' });
      const expectedRejection = expect(result).rejects.toThrow(
        'Timed out extracting'
      );

      await vi.waitFor(() => expect(tar.x).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(120_000);
      await expectedRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects GitHub archives that exceed the size cap', async () => {
    mockExecFileError('ENOENT');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '104857601' }),
    } as Response);

    await expect(
      fetchTemplate({ url: 'https://github.com/org/repo.git' })
    ).rejects.toThrow('too large');
    expect(open).not.toHaveBeenCalled();
    expect(archiveFile.write).not.toHaveBeenCalled();
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('rejects GitHub archive bodies that exceed the size cap while streaming', async () => {
    mockExecFileError('ENOENT');
    const releaseLock = vi.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValueOnce({
            done: false,
            value: { byteLength: 104857601 },
          }),
          releaseLock,
        }),
      },
    } as unknown as Response);

    await expect(
      fetchTemplate({ url: 'https://github.com/org/repo.git' })
    ).rejects.toThrow('too large');
    expect(archiveFile.write).not.toHaveBeenCalled();
    expect(archiveFile.close).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('includes auth hint on auth errors', async () => {
    // First call (ensureGitAvailable) succeeds, second (clone) fails with auth
    let callCount = 0;
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        callCount++;
        if (callCount === 1) {
          cb?.(null, '', '');
        } else {
          cb?.(new Error('terminal prompts disabled'));
        }
      }
    );

    await expect(
      fetchTemplate({ url: 'https://github.com/org/private-repo.git' })
    ).rejects.toThrow('gh auth setup-git');
  });

  it('omits auth hint on non-auth errors', async () => {
    let callCount = 0;
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        callCount++;
        if (callCount === 1) {
          cb?.(null, '', '');
        } else {
          cb?.(new Error('repository not found'));
        }
      }
    );

    const err = await fetchTemplate({
      url: 'https://github.com/org/repo.git',
    }).catch((e) => e);
    expect(err.message).toContain('repository not found');
    expect(err.message).not.toContain('gh auth setup-git');
  });

  it('cleans up temp directory on failure', async () => {
    let callCount = 0;
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
        callCount++;
        if (callCount === 1) {
          cb?.(null, '', '');
        } else {
          cb?.(new Error('clone failed'));
        }
      }
    );

    await expect(
      fetchTemplate({ url: 'https://github.com/org/repo.git' })
    ).rejects.toThrow();

    expect(rm).toHaveBeenCalledWith(TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });
});

describe('redactUrl', () => {
  it('redacts credentials in a bare URL', async () => {
    const { redactUrl } = await import('../git/fetcher');
    expect(redactUrl('https://user:pass@github.com/repo')).toBe(
      'https://***@github.com/repo'
    );
  });

  it('redacts credentials in URLs embedded in error messages', async () => {
    const { redactUrl } = await import('../git/fetcher');
    expect(
      redactUrl("fatal: cannot fetch from 'https://user:secret@github.com'")
    ).toBe("fatal: cannot fetch from 'https://***@github.com'");
  });

  it('leaves URLs without credentials unchanged', async () => {
    const { redactUrl } = await import('../git/fetcher');
    expect(redactUrl('https://github.com/normal/repo')).toBe(
      'https://github.com/normal/repo'
    );
  });

  it('redacts multiple credential URLs in one string', async () => {
    const { redactUrl } = await import('../git/fetcher');
    expect(
      redactUrl('mirror: https://a:b@x.com fallback: https://c:d@y.com')
    ).toBe('mirror: https://***@x.com fallback: https://***@y.com');
  });

  it('truncates inputs longer than 2048 chars to prevent ReDoS', async () => {
    const { redactUrl } = await import('../git/fetcher');
    const long = 'a'.repeat(3000);
    const result = redactUrl(long);
    expect(result.length).toBe(2048);
  });

  it('redacts credentials even when input exceeds the truncation cap', async () => {
    const { redactUrl } = await import('../git/fetcher');
    // Embed a credential URL within the first 2048 chars so it survives the
    // truncation step, then pad past the cap to confirm redaction still runs.
    const prefix = 'x'.repeat(100);
    const credUrl = 'https://user:secret@github.com/org/repo';
    const padding = 'y'.repeat(3000);
    const result = redactUrl(prefix + credUrl + padding);
    // Result is bounded by 2048 chars; redaction shortens by replacing
    // user:secret with ***, so length is at most 2048.
    expect(result.length).toBeLessThanOrEqual(2048);
    expect(result).not.toContain('secret');
    expect(result).not.toContain('user:');
    expect(result).toContain('https://***@github.com');
  });

  it('handles SSH URLs (git@host:path) without redacting since no userinfo at @', async () => {
    const { redactUrl } = await import('../git/fetcher');
    // git@github.com:org/repo.git uses : not /, so the regex (which matches scheme://) does not match
    expect(redactUrl('git@github.com:org/repo.git')).toBe(
      'git@github.com:org/repo.git'
    );
  });
});
