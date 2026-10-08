/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addAllowedRedirectUri } from '@microsoft/rayfin-tools-common/_internal/config';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import {
  formatBytes,
  MAX_ZIP_SIZE_BYTES,
  packageStaticFolder,
  validateStaticFolder,
} from '../services/static/staticHosting';

describe('staticHosting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── formatBytes ─────────────────────────────────────────────────
  describe('formatBytes', () => {
    it('returns "0 B" for zero', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats bytes', () => {
      expect(formatBytes(512)).toBe('512 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    });

    it('formats gigabytes', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    });

    it('formats fractional values', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
    });
  });

  // ── MAX_ZIP_SIZE_BYTES ──────────────────────────────────────────
  describe('MAX_ZIP_SIZE_BYTES', () => {
    it('equals 100 MB', () => {
      expect(MAX_ZIP_SIZE_BYTES).toBe(100 * 1024 * 1024);
    });
  });

  // ── addAllowedRedirectUri ───────────────────────────────────────
  describe('addAllowedRedirectUri', () => {
    const baseServices = {
      auth: { enabled: true, allowedRedirectUris: ['https://existing.com'] },
      data: { enabled: false },
      storage: { enabled: false },
    } as unknown as ReturnType<typeof addAllowedRedirectUri>;

    it('adds a new redirect URI', () => {
      const result = addAllowedRedirectUri(
        baseServices,
        'https://new-app.example.com'
      );
      expect(result.auth?.allowedRedirectUris).toContain(
        'https://new-app.example.com'
      );
      expect(result.auth?.allowedRedirectUris).toHaveLength(2);
    });

    it('deduplicates existing URIs', () => {
      const result = addAllowedRedirectUri(
        baseServices,
        'https://existing.com'
      );
      expect(result.auth?.allowedRedirectUris).toHaveLength(1);
    });

    it('handles case-insensitive deduplication', () => {
      const result = addAllowedRedirectUri(
        baseServices,
        'https://EXISTING.COM'
      );
      expect(result.auth?.allowedRedirectUris).toHaveLength(1);
    });

    it('handles trailing-slash normalization', () => {
      const result = addAllowedRedirectUri(
        baseServices,
        'https://existing.com/'
      );
      expect(result.auth?.allowedRedirectUris).toHaveLength(1);
    });

    it('rejects non-http(s) schemes', () => {
      expect(() =>
        addAllowedRedirectUri(baseServices, 'ftp://example.com')
      ).toThrow('Invalid redirect URI scheme');
    });

    it('does not mutate the original services object', () => {
      const original = {
        auth: {
          enabled: true,
          allowedRedirectUris: ['https://existing.com'],
        },
        data: { enabled: false },
        storage: { enabled: false },
      } as unknown as ReturnType<typeof addAllowedRedirectUri>;

      addAllowedRedirectUri(original, 'https://new.com');
      expect(original.auth?.allowedRedirectUris).toHaveLength(1);
    });

    it('handles empty allowedRedirectUris', () => {
      const emptyServices = {
        auth: { enabled: true },
        data: { enabled: false },
        storage: { enabled: false },
      } as unknown as ReturnType<typeof addAllowedRedirectUri>;

      const result = addAllowedRedirectUri(
        emptyServices,
        'https://app.example.com'
      );
      expect(result.auth?.allowedRedirectUris).toEqual([
        'https://app.example.com',
      ]);
    });

    it('returns the same reference when URI already exists (supports !== guard)', () => {
      const result = addAllowedRedirectUri(
        baseServices,
        'https://existing.com'
      );
      expect(result).toBe(baseServices);
    });

    it('returns the same reference when auth is undefined (does not synthesize auth block)', () => {
      const noAuthServices = {
        data: { enabled: false },
        storage: { enabled: false },
      } as unknown as ReturnType<typeof addAllowedRedirectUri>;

      const result = addAllowedRedirectUri(
        noAuthServices,
        'https://app.example.com'
      );
      expect(result).toBe(noAuthServices);
      expect(result.auth).toBeUndefined();
    });

    it('never appends an /auth/callback path', () => {
      const result = addAllowedRedirectUri(
        baseServices,
        'https://new-app.example.com'
      );
      const uris = result.auth?.allowedRedirectUris ?? [];
      for (const uri of uris) {
        expect(uri).not.toContain('/auth/callback');
      }
    });
  });

  // ── validateStaticFolder ────────────────────────────────────────
  describe('validateStaticFolder', () => {
    const projectRootUri = { scheme: 'file', path: '/project' } as vscode.Uri;
    const config = { enabled: true, folder: 'dist' };

    it('returns not-exists when folder is missing', async () => {
      vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(
        new Error('not found')
      );

      const result = await validateStaticFolder(projectRootUri, config);
      expect(result.exists).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('returns empty when folder has no files', async () => {
      vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
      });
      vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

      const result = await validateStaticFolder(projectRootUri, config);
      expect(result.exists).toBe(true);
      expect(result.empty).toBe(true);
    });

    it('returns valid for a folder with files', async () => {
      vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
      });
      vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
        ['index.html', vscode.FileType.File],
      ]);
      // stat for the file itself
      vi.mocked(vscode.workspace.fs.stat)
        .mockResolvedValueOnce({
          type: vscode.FileType.Directory,
          ctime: 0,
          mtime: 0,
          size: 0,
        })
        .mockResolvedValueOnce({
          type: vscode.FileType.File,
          ctime: 0,
          mtime: 0,
          size: 256,
        });

      const result = await validateStaticFolder(projectRootUri, config);
      expect(result.exists).toBe(true);
      expect(result.empty).toBe(false);
      expect(result.fileCount).toBe(1);
      expect(result.totalSizeBytes).toBe(256);
    });
  });

  // ── packageStaticFolder ─────────────────────────────────────────
  describe('packageStaticFolder', () => {
    const folderUri = { scheme: 'file', path: '/project/dist' } as vscode.Uri;

    it('produces a ZIP with the correct PK signature', async () => {
      vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
        ['index.html', vscode.FileType.File],
      ]);
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
        new TextEncoder().encode('<html></html>')
      );

      const zip = await packageStaticFolder(folderUri);
      // ZIP files start with PK magic bytes
      expect(zip[0]).toBe(0x50); // P
      expect(zip[1]).toBe(0x4b); // K
    });

    it('includes subdirectory files', async () => {
      vi.mocked(vscode.workspace.fs.readDirectory)
        .mockResolvedValueOnce([
          ['index.html', vscode.FileType.File],
          ['assets', vscode.FileType.Directory],
        ])
        .mockResolvedValueOnce([['style.css', vscode.FileType.File]]);

      vi.mocked(vscode.workspace.fs.readFile)
        .mockResolvedValueOnce(new TextEncoder().encode('<html></html>'))
        .mockResolvedValueOnce(new TextEncoder().encode('body {}'));

      const zip = await packageStaticFolder(folderUri);
      expect(zip.byteLength).toBeGreaterThan(0);
      // Verify PK signature
      expect(zip[0]).toBe(0x50);
      expect(zip[1]).toBe(0x4b);
    });
  });
});
