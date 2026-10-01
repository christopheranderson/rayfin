import { execFile } from 'child_process';
import { mkdtemp, open, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import * as tar from 'tar';

import type { TemplateSource } from '../types.js';

import { isFullCommitShaRef, stripQualifiedRefPrefix } from './ref-shapes.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_ARCHIVE_BYTES = 500 * 1024 * 1024;
const ARCHIVE_EXTRACTION_TIMEOUT_MS = 120_000;
const ARCHIVE_FILENAME = 'template.tar.gz';
const GIT_UNAVAILABLE_MESSAGE =
  'git is not available on PATH. Please install git to use template fetching.';
const GIT_REQUIRED_UNSUPPORTED_MESSAGE =
  `${GIT_UNAVAILABLE_MESSAGE} Expected a public GitHub template URL in the form ` +
  'https://github.com/<owner>/<repo>[.git] without credentials. Git is required ' +
  'for malformed GitHub URLs, GitHub Enterprise, non-GitHub, SSH, or private repository templates.';

interface GitHubArchiveSource {
  owner: string;
  repo: string;
  ref: string;
}

export interface FetchTemplateOptions {
  onArchiveFallback?: (message: string) => void;
}

/**
 * Ensure git is available on the PATH.
 * Throws if git cannot be found.
 */
export async function ensureGitAvailable(): Promise<void> {
  if (await isGitAvailable()) {
    return;
  }

  throw new Error(GIT_UNAVAILABLE_MESSAGE);
}

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Redact userinfo from a URL (or any string containing URLs) to prevent credential leaks in error messages. Exported for testing. */
export function redactUrl(url: string): string {
  // Bound input to avoid ReDoS on adversarial inputs, but redact AFTER bounding
  // - otherwise long error messages with embedded credentials at any position
  // leak through the truncation path.
  const bounded = url.length > 2048 ? url.slice(0, 2048) : url;
  // Match URLs anywhere in the string (no ^ anchor) because git error messages embed URLs in prose.
  return bounded.replace(/([a-z]+:\/\/)[^/@\s]{1,256}@/gi, '$1***@');
}

function parseGitHubArchiveSource(
  source: TemplateSource
): GitHubArchiveSource | undefined {
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'github.com' ||
    parsed.username ||
    parsed.password
  ) {
    return undefined;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return undefined;
  }

  const owner = segments[0];
  const repo = segments[1].endsWith('.git')
    ? segments[1].slice(0, -'.git'.length)
    : segments[1];

  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.length === 0
  ) {
    return undefined;
  }

  return {
    owner,
    repo,
    // GitHub archive URLs accept HEAD for the repository default branch. Pinned
    // first-class templates should still provide an explicit tag or SHA.
    ref: source.ref ?? 'HEAD',
  };
}

/**
 * Strip `refs/tags/` or `refs/heads/` prefixes so a fully-qualified ref can be
 * passed to `git clone --branch <name>`. Implementation lives in
 * `./ref-shapes.ts` so the same shape checks apply at every boundary; this
 * file re-exports the symbol for backcompat with existing imports.
 */
export { stripQualifiedRefPrefix } from './ref-shapes.js';

function encodeGitRefPath(ref: string): string {
  const segments = ref.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new Error(`Invalid GitHub archive ref '${ref}'`);
  }

  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function buildGitHubArchiveUrl(source: GitHubArchiveSource): string {
  return `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/archive/${encodeGitRefPath(source.ref)}.tar.gz`;
}

function isSafeArchivePath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return false;
  }

  return !normalized.split('/').some((segment) => segment === '..');
}

function isUnsupportedArchiveLink(entry: unknown): boolean {
  const type = (entry as { type?: unknown }).type;
  return type === 'SymbolicLink' || type === 'Link';
}

async function writeArchiveBody(
  response: Response,
  archivePath: string,
  archiveUrl: string
): Promise<void> {
  if (!response.body) {
    throw new Error(
      `Empty response body for GitHub template archive from '${redactUrl(archiveUrl)}'`
    );
  }

  const reader = response.body.getReader();
  const file = await open(archivePath, 'w');
  let primaryError: unknown;
  let closeError: unknown;

  try {
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `GitHub template archive from '${redactUrl(archiveUrl)}' is too large. Maximum supported archive size is ${MAX_ARCHIVE_BYTES} bytes.`
        );
      }

      await file.write(value);
    }
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    reader.releaseLock();
    try {
      await file.close();
    } catch (err) {
      if (primaryError === undefined) {
        closeError = err;
      }
    }
  }

  if (closeError !== undefined) {
    throw closeError;
  }
}

async function downloadGitHubArchive(
  source: GitHubArchiveSource,
  targetDir: string
): Promise<void> {
  const archiveUrl = buildGitHubArchiveUrl(source);
  const archiveDir = await mkdtemp(join(tmpdir(), 'rayfin-template-archive-'));
  const archivePath = join(archiveDir, ARCHIVE_FILENAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GIT_TIMEOUT_MS);

  try {
    const response = await fetch(archiveUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'rayfin-cli' },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `Could not download GitHub template archive from '${redactUrl(archiveUrl)}' (HTTP ${response.status} ${response.statusText}). The repository may be private, deleted, or the ref may not exist. Git is required to use templates from private repositories.`
      );
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `GitHub template archive from '${redactUrl(archiveUrl)}' is too large. Maximum supported archive size is ${MAX_ARCHIVE_BYTES} bytes.`
      );
    }

    await writeArchiveBody(response, archivePath, archiveUrl);
    await extractGitHubArchive(archivePath, archiveUrl, targetDir);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Timed out downloading GitHub template archive from '${redactUrl(archiveUrl)}'`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    await rm(archiveDir, { recursive: true, force: true });
  }
}

async function extractGitHubArchive(
  archivePath: string,
  archiveUrl: string,
  targetDir: string
): Promise<void> {
  let extractedBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const extraction = tar.x({
    file: archivePath,
    cwd: targetDir,
    strip: 1,
    strict: true,
    filter: (entryPath, entry) => {
      if (!isSafeArchivePath(entryPath)) {
        throw new Error(`Unsafe path in GitHub template archive: ${entryPath}`);
      }
      if (isUnsupportedArchiveLink(entry)) {
        throw new Error(
          `Unsupported link in GitHub template archive: ${entryPath}`
        );
      }

      extractedBytes += entry.size ?? 0;
      if (extractedBytes > MAX_EXTRACTED_ARCHIVE_BYTES) {
        throw new Error(
          `GitHub template archive from '${redactUrl(archiveUrl)}' expands beyond ${MAX_EXTRACTED_ARCHIVE_BYTES} bytes.`
        );
      }

      return true;
    },
  });

  try {
    await Promise.race([
      extraction,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out extracting GitHub template archive from '${redactUrl(archiveUrl)}'`
              )
            ),
          ARCHIVE_EXTRACTION_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Fetch a template from a git URL by cloning to a temp directory.
 * For this PR, always clones fresh (no caching).
 * Returns the local path to the cloned repository.
 */
export async function fetchTemplate(
  source: TemplateSource,
  options: FetchTemplateOptions = {}
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'rayfin-template-'));
  let success = false;
  let usedArchiveFallback = false;

  try {
    if (!(await isGitAvailable())) {
      const archiveSource = parseGitHubArchiveSource(source);
      if (!archiveSource) {
        throw new Error(GIT_REQUIRED_UNSUPPORTED_MESSAGE);
      }

      usedArchiveFallback = true;
      options.onArchiveFallback?.(
        'git not found; fetching public GitHub template archive (commit SHA verification is unavailable in archive fallback).'
      );
      await downloadGitHubArchive(archiveSource, tempDir);
      success = true;
      return tempDir;
    }

    const isPinnedCommit = source.ref ? isFullCommitShaRef(source.ref) : false;
    const args = ['clone', '--depth', '1'];
    const gitExecOptions = {
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...(typeof process !== 'undefined' ? process.env : undefined),
        GIT_TERMINAL_PROMPT: '0',
      },
    };

    if (!isPinnedCommit) {
      args.push('--single-branch');
    }

    if (source.ref && !isPinnedCommit) {
      // `git clone --branch <name>` accepts short branch/tag names, not
      // fully-qualified refs. Strip the `refs/tags/` and `refs/heads/`
      // prefixes so registry entries and `-t <url>#<ref>` inputs that use
      // the fully-qualified form (e.g. `refs/tags/v1`) actually resolve
      // instead of failing with "Remote branch not found".
      args.push('--branch', stripQualifiedRefPrefix(source.ref));
    }

    // '--' separates flags from positional arguments (security)
    args.push('--', source.url, tempDir);

    await execFileAsync('git', args, gitExecOptions);

    if (source.ref && isPinnedCommit) {
      await execFileAsync(
        'git',
        ['-C', tempDir, 'fetch', '--depth', '1', 'origin', source.ref],
        gitExecOptions
      );
      await execFileAsync(
        'git',
        ['-C', tempDir, 'checkout', '--detach', source.ref],
        gitExecOptions
      );
    }

    success = true;
    return tempDir;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (usedArchiveFallback || message.includes(GIT_UNAVAILABLE_MESSAGE)) {
      throw new Error(redactUrl(message));
    }

    const isAuthError =
      message.includes('terminal prompts disabled') ||
      message.includes('Authentication failed') ||
      message.includes('could not read Username');
    const authHint = isAuthError
      ? '\nHint: configure git credentials for this host (e.g., run `gh auth setup-git` for GitHub repos)'
      : '';
    throw new Error(
      `Failed to clone template from '${redactUrl(source.url)}': ${redactUrl(message)}${authHint}`
    );
  } finally {
    if (!success) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
