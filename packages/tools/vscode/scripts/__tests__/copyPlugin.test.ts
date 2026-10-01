/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attachMcpServer,
  copyTrackedPlugin,
  trackedPluginFiles,
} from '../copy-plugin.mjs';

/**
 * The vsix is packaged from a developer's working tree, so a recursive copy of
 * `plugin/` shipped whatever happened to be sitting there: gitignored output, a
 * half-written skill, an editor backup. The public sync already refuses to
 * publish anything but committed content; this is the same guarantee for the
 * other consumer of `plugin/`.
 */
describe('copying the plugin into the extension', () => {
  let repo: string;
  let source: string;

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }

  function plant(relative: string, contents: string): void {
    const target = join(repo, 'plugin', relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'rayfin-plugin-copy-'));
    source = join(repo, 'plugin');

    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    plant('plugin.json', '{"name":"rayfin"}');
    plant('skills/rayfin-getting-started/SKILL.md', '# skill');
    git('add', 'plugin');

    // Never added. A directory walk cannot tell these from the payload.
    plant('scratch.md', 'notes to self');
    plant('skills/half-written/SKILL.md', 'wip');
    writeFileSync(join(repo, '.gitignore'), 'plugin/ignored.json\n');
    plant('ignored.json', '{"token":"secret"}');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists the tracked payload and nothing else', () => {
    expect([...trackedPluginFiles(repo)].sort()).toEqual([
      'plugin.json',
      'skills/rayfin-getting-started/SKILL.md',
    ]);
  });

  it('copies the tracked payload and leaves untracked files behind', () => {
    const dest = join(repo, 'out');
    copyTrackedPlugin(source, dest, trackedPluginFiles(repo));

    expect(existsSync(join(dest, 'plugin.json'))).toBe(true);
    expect(
      existsSync(join(dest, 'skills/rayfin-getting-started/SKILL.md'))
    ).toBe(true);

    for (const leaked of [
      'scratch.md',
      'ignored.json',
      'skills/half-written/SKILL.md',
    ]) {
      expect(existsSync(join(dest, leaked)), leaked).toBe(false);
    }
  });

  it('reads tracked paths from the working tree, not from HEAD', () => {
    // Editing a skill and rebuilding has to keep working. Sourcing from a
    // commit would be stricter than needed here and would break that loop.
    git('commit', '--quiet', '-m', 'initial');
    plant('skills/rayfin-getting-started/SKILL.md', '# edited, uncommitted');

    const dest = join(repo, 'out');
    copyTrackedPlugin(source, dest, trackedPluginFiles(repo));

    expect(
      readFileSync(join(dest, 'skills/rayfin-getting-started/SKILL.md'), 'utf8')
    ).toBe('# edited, uncommitted');
  });

  it('refuses to publish a manifest git does not track', () => {
    // The manifest was the one file that escaped the allow-list: the copy
    // skipped it, then the MCP step reopened it from the source anyway. So an
    // untracked plugin.json still reached the vsix.
    git('rm', '--quiet', '--cached', 'plugin/plugin.json');

    const dest = join(repo, 'out');
    const files = trackedPluginFiles(repo);
    expect(files).not.toContain('plugin.json');

    copyTrackedPlugin(source, dest, files);

    expect(() => attachMcpServer(dest, files)).toThrow(/not tracked/);
    expect(existsSync(join(dest, 'plugin.json'))).toBe(false);
  });

  it('attaches the MCP server to the copied manifest', () => {
    const dest = join(repo, 'out');
    const files = trackedPluginFiles(repo);
    copyTrackedPlugin(source, dest, files);
    attachMcpServer(dest, files);

    const manifest = JSON.parse(
      readFileSync(join(dest, 'plugin.json'), 'utf8')
    );
    expect(manifest.name).toBe('rayfin');
    expect(manifest.mcpServers.rayfin.command).toBe('npx');

    // The source payload stays byte-for-byte what we publish.
    expect(
      JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8')).mcpServers
    ).toBeUndefined();
  });
});
