//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import license from 'rollup-plugin-license';

import { resolve } from 'path';

const projectRoot = process.env.PROJECT_ROOT || import.meta.dirname;

// Dev-only middleware: makes the local Vite server compatible with browsers that
// enforce Local Network Access (LNA) checks when a public origin (the Fabric portal)
// embeds an iframe pointing at http://localhost. Sets the LNA opt-in response header
// on every response and short-circuits the corresponding preflight OPTIONS request.
// This is required for fetch/XHR subresources from the embedded app — top-level
// iframe navigations additionally require launching Chromium with the
// `--disable-features=...LocalNetworkAccessChecks` flag (see .playwright-config.json).
const localNetworkAccessPlugin: PluginOption = {
  name: 'local-network-access-headers',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (
        req.method === 'OPTIONS' &&
        req.headers['access-control-request-private-network']
      ) {
        const origin = req.headers.origin || '*';
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] || '*'
        );
        res.statusCode = 204;
        res.end();
        return;
      }
      next();
    });
  },
};

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Pin the dev server to Rayfin's per-project port (VITE_PORT, mapped from
  // RAYFIN_PUBLIC_FRONTEND_PORT in .env.local) so multiple local frontends
  // don't collide and the deployed backend can allow-list one stable origin.
  const env = loadEnv(mode, projectRoot, 'VITE_');
  const port = env.VITE_PORT ? Number(env.VITE_PORT) : undefined;

  // Fail the production build early when the Rayfin publishable key is missing
  // for a remote backend. Vite statically inlines `import.meta.env.*`, so an
  // unset key would otherwise ship as `undefined` and only crash at runtime.
  // A localhost API URL resolves to the local-dev path, which needs no key.
  if (command === 'build') {
    const apiUrl = env.VITE_RAYFIN_API_URL;
    const isRemoteBackend =
      !!apiUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(apiUrl);
    if (isRemoteBackend && !env.VITE_RAYFIN_PUBLISHABLE_KEY) {
      throw new Error(
        'Missing required Rayfin client environment variable: VITE_RAYFIN_PUBLISHABLE_KEY.\n' +
          'Regenerate .env.local from rayfin/.env with: rayfin env --framework vite\n' +
          '(run `rayfin up` first if rayfin/.env has not been populated yet).'
      );
    }
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      localNetworkAccessPlugin,
      rayfinLocalDev(),
    ],
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src'),
      },
    },
    ...(port ? { server: { port, strictPort: true } } : {}),
    build: {
      target: 'es2022',
      commonjsOptions: {
        include: [/node_modules/],
      },
      rollupOptions: {
        plugins: [
          license({
            thirdParty: {
              multipleVersions: true,
              output: {
                file: resolve(projectRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'),
                template(dependencies) {
                  if (dependencies.length === 0) {
                    return 'No third-party dependencies.';
                  }
                  return (
                    'This file was auto-generated at build time.\n\n' +
                    dependencies
                      .map((dep) => {
                        const lines = [
                          `${dep.name}@${dep.version}`,
                          `License: ${dep.license || 'UNKNOWN'}`,
                        ];
                        if (dep.author) {
                          lines.push(
                            `Author: ${typeof dep.author === 'string' ? dep.author : dep.author.text()}`
                          );
                        }
                        if (dep.noticeText) {
                          lines.push('', 'NOTICE:', dep.noticeText.trim());
                        }
                        if (dep.licenseText) {
                          lines.push('', dep.licenseText.trim());
                        }
                        return lines.join('\n');
                      })
                      .join('\n\n' + '='.repeat(60) + '\n\n')
                  );
                },
              },
            },
          }),
        ],
      },
    },
    esbuild: {
      target: 'es2022',
    },
    optimizeDeps: {
      include: [
        '@microsoft/fabric-visuals',
        '@microsoft/fabric-datagrid',
        '@microsoft/fabric-visuals-core',
      ],
      esbuildOptions: {
        target: 'es2022',
      },
    },
  };
});
