/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Auto-detect the frontend framework for a Rayfin project at runtime.
 *
 * Detection is performed on-the-fly — nothing is persisted to `rayfin.yml`.
 * The result drives `rayfin env` (`.env.local` generation) and the auto-emit
 * in `rayfin dev` / `rayfin up` / `rayfin up switch`.
 *
 * Detection order:
 *   1. `vite.config.{ts,js,mjs,cjs}` at the project root → `vite`.
 *   2. `next.config.{ts,js,mjs,cjs}` at the project root → `nextjs`.
 *   3. `package.json` listing `vite` (deps or devDeps) → `vite`.
 *   4. `package.json` listing `next` (deps or devDeps) → `nextjs`.
 *   5. Otherwise → `null` (no auto-detection).
 *
 * When no framework can be detected, callers print a hint directing the
 * user to `rayfin env --framework <fw>` for manual generation.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import type { FrontendFramework } from '@microsoft/rayfin-tools-common/_internal/config';

const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

const NEXT_CONFIG_FILES = [
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
];

/**
 * Inspect a project directory and return the most likely frontend framework,
 * or `null` when nothing can be inferred.
 */
export function detectFrontendFramework(
  projectRoot: string
): FrontendFramework | null {
  for (const f of VITE_CONFIG_FILES) {
    if (existsSync(join(projectRoot, f))) return 'vite';
  }
  for (const f of NEXT_CONFIG_FILES) {
    if (existsSync(join(projectRoot, f))) return 'nextjs';
  }

  const pkgJsonPath = join(projectRoot, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all.vite) return 'vite';
      if (all.next) return 'nextjs';
    } catch {
      // Ignore malformed package.json — fall through to null.
    }
  }
  return null;
}
