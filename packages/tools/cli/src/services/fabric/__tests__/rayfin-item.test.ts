import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RayfinItemManager,
  RayfinItemReuseDeclinedError,
} from '../rayfin-item.js';

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

const promptMock = vi.mocked(inquirer.prompt);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RayfinItemManager', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('returns undefined only when the item lookup responds with HTTP 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));

    await expect(
      new RayfinItemManager('token').getFabricItemById(
        'workspace-id',
        'item-id'
      )
    ).resolves.toBeUndefined();
  });

  it.each([401, 403, 500])(
    'preserves HTTP %s and correlation IDs containing 404',
    async (status) => {
      const rootActivityId = '0feb720a-5404-4200-879f-1f41462c8595';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              errorCode: 'InvalidToken',
              message: 'Access token is invalid',
            }),
            { status, headers: { 'x-ms-root-activity-id': rootActivityId } }
          )
        )
      );

      await expect(
        new RayfinItemManager('token').getFabricItemById(
          'workspace-id',
          'item-id'
        )
      ).rejects.toMatchObject({
        statusCode: status,
        message: expect.stringContaining(`RootActivityId: ${rootActivityId}`),
      });
    }
  );

  it('creates a new Rayfin item without prompting when no same-named remote item exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: 'new-item-id',
            displayName: 'my-app',
            type: 'AppBackend',
            workspaceId: 'workspace-id',
          },
          201
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new RayfinItemManager('token');

    const item = await manager.getOrCreateRayfinItem('workspace-id', 'my-app', {
      workspaceDisplayName: 'My Workspace',
    });

    expect(item.id).toBe('new-item-id');
    expect(promptMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
  });

  it('preserves the Fabric error code when item creation exhausts capacity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            errorCode: 'CapacityLimitExceeded',
            message: 'The capacity cannot create another item.',
          },
          429
        )
      )
    );

    await expect(
      new RayfinItemManager('token').createRayfinItem('workspace-id', 'my-app')
    ).rejects.toMatchObject({
      name: 'FabricError',
      statusCode: 429,
      errorCode: 'CapacityLimitExceeded',
    });
  });

  it('routes the 201 creation banner through the injected output sink', async () => {
    const created = {
      id: 'new-item-id',
      displayName: 'my-app',
      type: 'AppBackend',
      workspaceId: 'workspace-id',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(created, 201))
    );
    const output = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const manager = new RayfinItemManager('token', output);

    await expect(
      manager.createRayfinItem('workspace-id', 'my-app')
    ).resolves.toEqual(created);

    expect(output.log).toHaveBeenCalledWith('Resource created successfully');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('prompts and reuses the same-named remote item when the user confirms', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 'existing-item-id',
            displayName: 'my-app',
            type: 'AppBackend',
            workspaceId: 'workspace-id',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    promptMock.mockResolvedValueOnce({ confirm: true });

    const manager = new RayfinItemManager('token');

    const item = await manager.getOrCreateRayfinItem('workspace-id', 'my-app', {
      workspaceDisplayName: 'My Workspace',
    });

    expect(item.id).toBe('existing-item-id');
    expect(promptMock).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'confirm',
        name: 'confirm',
        message: 'Use the existing item and overwrite its config?',
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels without creating or reusing when the user declines the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 'existing-item-id',
            displayName: 'my-app',
            type: 'AppBackend',
            workspaceId: 'workspace-id',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    promptMock.mockResolvedValueOnce({ confirm: false });

    const manager = new RayfinItemManager('token');

    await expect(
      manager.getOrCreateRayfinItem('workspace-id', 'my-app', {
        workspaceDisplayName: 'My Workspace',
      })
    ).rejects.toBeInstanceOf(RayfinItemReuseDeclinedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails without prompting in non-interactive mode when a same-named remote item exists', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 'existing-item-id',
            displayName: 'my-app',
            type: 'AppBackend',
            workspaceId: 'workspace-id',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new RayfinItemManager('token');

    await expect(
      manager.getOrCreateRayfinItem('workspace-id', 'my-app', {
        nonInteractive: true,
        workspaceDisplayName: 'My Workspace',
      })
    ).rejects.toThrow(
      'Run `rayfin up` in an interactive terminal to confirm reuse'
    );
    expect(promptMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the same-named remote item without prompting when confirmReuse is set', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 'existing-item-id',
            displayName: 'my-app',
            type: 'AppBackend',
            workspaceId: 'workspace-id',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new RayfinItemManager('token');

    const item = await manager.getOrCreateRayfinItem('workspace-id', 'my-app', {
      nonInteractive: true,
      confirmReuse: true,
      workspaceDisplayName: 'My Workspace',
    });

    expect(item.id).toBe('existing-item-id');
    expect(promptMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finds a matching item on a later page, following pagination', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'other-item-id',
              displayName: 'another-app',
              type: 'AppBackend',
              workspaceId: 'workspace-id',
            },
          ],
          continuationToken: 'page-2-token',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'existing-item-id',
              displayName: 'my-app',
              type: 'AppBackend',
              workspaceId: 'workspace-id',
            },
          ],
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new RayfinItemManager('token');

    const found = await manager.getRayfinItemByName('workspace-id', 'my-app');

    expect(found?.id).toBe('existing-item-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain(
      '&continuationToken=page-2-token'
    );
  });

  it('preserves the type filter when following a continuationUri on the items path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'other-item-id',
              displayName: 'another-app',
              type: 'AppBackend',
              workspaceId: 'workspace-id',
            },
          ],
          // Same-origin continuationUri for the items endpoint, carrying the
          // type filter the service expects on the next page.
          continuationUri:
            'https://api.fabric.microsoft.com/v1/workspaces/workspace-id/items?type=AppBackend&continuationToken=page-2',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              id: 'existing-item-id',
              displayName: 'my-app',
              type: 'AppBackend',
              workspaceId: 'workspace-id',
            },
          ],
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const manager = new RayfinItemManager('token');

    const found = await manager.getRayfinItemByName('workspace-id', 'my-app');

    expect(found?.id).toBe('existing-item-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('type=AppBackend');
    expect(fetchMock.mock.calls[1][0]).toContain('continuationToken=page-2');
  });

  describe('getExtendedProperties', () => {
    const ready = { extendedProperties: { BaaSEndpoint: 'https://workload' } };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Drives a call that is expected to back off, letting each scheduled
     * retry wait elapse without holding the suite for the real delays.
     */
    async function settle<T>(promise: Promise<T>): Promise<T> {
      const assertion = promise.catch((error: unknown) => error as T);
      await vi.advanceTimersByTimeAsync(60_000);
      return assertion;
    }

    it('retries a 5xx and resolves once the workload finishes provisioning', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
        .mockResolvedValueOnce(jsonResponse(ready));
      vi.stubGlobal('fetch', fetchMock);

      const result = await settle(
        new RayfinItemManager('token').getExtendedProperties('ws', 'item')
      );

      expect(result).toEqual({ BaaSEndpoint: 'https://workload' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a 200 whose extendedProperties has no BaaSEndpoint yet', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ extendedProperties: {} }))
        .mockResolvedValueOnce(jsonResponse(ready));
      vi.stubGlobal('fetch', fetchMock);

      const result = await settle(
        new RayfinItemManager('token').getExtendedProperties('ws', 'item')
      );

      expect(result).toEqual({ BaaSEndpoint: 'https://workload' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404])(
      'does not retry HTTP %s, which retrying cannot fix',
      async (status) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(jsonResponse({ message: 'nope' }, status));
        vi.stubGlobal('fetch', fetchMock);

        const error = await settle(
          new RayfinItemManager('token').getExtendedProperties('ws', 'item')
        );

        expect(error).toMatchObject({ statusCode: status });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    );

    it('surfaces the failure after exhausting retries', async () => {
      // A fresh Response per attempt: a single instance would have its body
      // consumed by the first read, masking the real error on later attempts.
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ message: 'boom' }, 500));
      vi.stubGlobal('fetch', fetchMock);

      const error = await settle(
        new RayfinItemManager('token').getExtendedProperties('ws', 'item')
      );

      expect(error).toMatchObject({ statusCode: 500 });
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    /** Captures what a console-backed caller would actually print. */
    function spyOutput() {
      return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    }

    it('logs nothing when a later attempt recovers the deployment', async () => {
      // Legacy `up` and hydrateDeploymentFromFabric build this manager with
      // console output, so a per-attempt 500 would otherwise print
      // "Error making Fabric API request" on a deployment that then succeeds.
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ message: 'boom' }, 500)
        )
        .mockImplementationOnce(async () => jsonResponse(ready));
      vi.stubGlobal('fetch', fetchMock);
      const output = spyOutput();

      const result = await settle(
        new RayfinItemManager('token', output).getExtendedProperties(
          'ws',
          'item'
        )
      );

      expect(result).toEqual({ BaaSEndpoint: 'https://workload' });
      expect(output.error).not.toHaveBeenCalled();
    });

    it('logs once — not per attempt — when retries are exhausted', async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ message: 'boom' }, 500));
      vi.stubGlobal('fetch', fetchMock);
      const output = spyOutput();

      await settle(
        new RayfinItemManager('token', output).getExtendedProperties(
          'ws',
          'item'
        )
      );

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(output.error).toHaveBeenCalledTimes(1);
      expect(output.error).toHaveBeenCalledWith(
        expect.stringContaining('Error making Fabric API request')
      );
    });

    it('still logs a non-retryable failure exactly once', async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ message: 'nope' }, 404));
      vi.stubGlobal('fetch', fetchMock);
      const output = spyOutput();

      await settle(
        new RayfinItemManager('token', output).getExtendedProperties(
          'ws',
          'item'
        )
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(output.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('createRayfinItem', () => {
    const created = { id: 'new-item', displayName: 'my-app' };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function settle<T>(promise: Promise<T>): Promise<T> {
      const assertion = promise.catch((error: unknown) => error as T);
      await vi.advanceTimersByTimeAsync(60_000);
      return assertion;
    }

    function spyOutput() {
      return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    }

    /**
     * Routes the create POST and the name-lookup GET independently, so a test
     * can say what the workspace lists at the moment the reconcile looks.
     */
    function routed(options: {
      post: () => Response;
      existing?: (lookup: number) => unknown[];
    }) {
      const posts: string[] = [];
      let lookups = 0;
      const fetchMock = vi.fn(
        async (url: string | URL, init?: RequestInit): Promise<Response> => {
          if ((init?.method ?? 'GET') === 'POST') {
            posts.push(String(url));
            return options.post();
          }
          lookups += 1;
          return jsonResponse({ value: options.existing?.(lookups) ?? [] });
        }
      );
      return { fetchMock, posts, lookupCount: () => lookups };
    }

    it('creates the item on the happy path without an extra lookup', async () => {
      const { fetchMock, posts, lookupCount } = routed({
        post: () => jsonResponse(created, 201),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await settle(
        new RayfinItemManager('token').createRayfinItem('ws', 'my-app')
      );

      expect(result).toMatchObject({ id: 'new-item' });
      expect(posts).toHaveLength(1);
      expect(lookupCount()).toBe(0);
    });

    it('adopts the item the ambiguous create already made, without posting again', async () => {
      // The create can reach Fabric and still surface as a 5xx. Re-posting
      // would leave a duplicate item behind, so the outcome is reconciled.
      const { fetchMock, posts } = routed({
        post: () => jsonResponse({ message: 'boom' }, 500),
        existing: () => [created],
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await settle(
        new RayfinItemManager('token').createRayfinItem('ws', 'my-app')
      );

      expect(result).toMatchObject({ id: 'new-item' });
      expect(posts).toHaveLength(1);
    });

    it('waits out a consistency delay before the item is listed', async () => {
      // A successful create can stay invisible to List Items for a moment.
      // Posting again on that first empty lookup would fail the deploy with a
      // display-name conflict, so the reconcile keeps polling instead.
      const { fetchMock, posts, lookupCount } = routed({
        post: () => jsonResponse({ message: 'boom' }, 500),
        existing: (lookup) => (lookup >= 3 ? [created] : []),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await settle(
        new RayfinItemManager('token').createRayfinItem('ws', 'my-app')
      );

      expect(result).toMatchObject({ id: 'new-item' });
      expect(posts).toHaveLength(1);
      expect(lookupCount()).toBe(3);
    });

    it('never posts twice, even when the item never appears', async () => {
      // The create most likely never ran. Surfacing the original failure lets
      // the user re-run `rayfin up`; a second POST here could duplicate an
      // item that was merely slow to list.
      const { fetchMock, posts } = routed({
        post: () => jsonResponse({ message: 'boom' }, 500),
        existing: () => [],
      });
      vi.stubGlobal('fetch', fetchMock);
      const output = spyOutput();

      const error = await settle(
        new RayfinItemManager('token', output).createRayfinItem('ws', 'my-app')
      );

      expect(error).toMatchObject({ statusCode: 500 });
      expect(posts).toHaveLength(1);
      expect(output.error).toHaveBeenCalledTimes(1);
    });

    it('does not reconcile a 4xx, which answers that the create did not run', async () => {
      const { fetchMock, posts, lookupCount } = routed({
        post: () => jsonResponse({ message: 'nope' }, 403),
      });
      vi.stubGlobal('fetch', fetchMock);
      const output = spyOutput();

      const error = await settle(
        new RayfinItemManager('token', output).createRayfinItem('ws', 'my-app')
      );

      expect(error).toMatchObject({ statusCode: 403 });
      expect(posts).toHaveLength(1);
      expect(lookupCount()).toBe(0);
      expect(output.error).toHaveBeenCalledTimes(1);
    });
  });
});
