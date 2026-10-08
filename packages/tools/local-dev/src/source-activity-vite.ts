import { resolve } from 'node:path';

import type { ViteDevServer } from 'vite';

import {
  createSourceActivityFeed,
  isActivityRequest,
} from './source-activity.js';

/** @internal Attach the welcome's development-only feed to Vite's existing watcher. */
export function attachSourceActivity(
  server: ViteDevServer,
  workspaceRoot = resolve(server.config.root, '..', '..')
): () => void {
  const feed = createSourceActivityFeed({ root: workspaceRoot });
  const base = server.config.base ?? '/';
  let disposed = false;
  let failureReported = false;
  const reportFailure = () => {
    if (failureReported) return;
    failureReported = true;
    server.config.logger.warn(
      'Source activity is unavailable. Check source file permissions and rayfin.yml.'
    );
  };
  void feed.start().catch(reportFailure);

  server.watcher.add(
    ['packages/shared', 'packages/data', 'packages/functions', 'rayfin'].map(
      (path) => resolve(workspaceRoot, path)
    )
  );

  const onFile = (path: string) => feed.notifyPath(path);
  const onDir = (path: string) => feed.notifyDir(path);
  const onError = () => feed.notifyAll();
  server.watcher.on('add', onFile);
  server.watcher.on('change', onFile);
  server.watcher.on('unlink', onFile);
  server.watcher.on('addDir', onDir);
  server.watcher.on('unlinkDir', onDir);
  server.watcher.on('error', onError);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    server.watcher.off('add', onFile);
    server.watcher.off('change', onFile);
    server.watcher.off('unlink', onFile);
    server.watcher.off('addDir', onDir);
    server.watcher.off('unlinkDir', onDir);
    server.watcher.off('error', onError);
    server.httpServer?.off('close', dispose);
    feed.close();
  };
  server.httpServer?.once('close', dispose);

  server.middlewares.use((request, response, next) => {
    if (disposed || !isActivityRequest(request.url, base)) {
      next();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    void feed.read().then(
      (snapshot) => {
        if (snapshot === null) {
          response.statusCode = 503;
          response.end(
            JSON.stringify({ error: 'Source activity is initializing' })
          );
          return;
        }
        response.statusCode = 200;
        failureReported = false;
        response.end(JSON.stringify(snapshot));
      },
      () => {
        reportFailure();
        response.statusCode = 503;
        response.end(
          JSON.stringify({
            error: 'Source activity is temporarily unavailable',
          })
        );
      }
    );
  });
  return dispose;
}
