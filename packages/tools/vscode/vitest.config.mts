/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(import.meta.dirname, 'src/__mocks__/vscode.js'),
      '@vscode/extension-telemetry': resolve(
        import.meta.dirname,
        'src/__mocks__/@vscode/extension-telemetry.js'
      ),
    },
  },
  test: {
    root: '.',
    // `scripts/` holds the build steps that assemble the vsix payload. Their
    // tests live beside them because the package tsconfig compiles `src` for a
    // DOM target with no Node types, and these need the filesystem.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  },
});
