import type { Http } from '@microsoft/rayfin-tools-common/_internal/adapters';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getRayfinItemByName = vi.fn();
const getFabricItemById = vi.fn();
const createRayfinItem = vi.fn();
const fabricFetch = vi.fn();

vi.mock('../../../config/constants.js', () => ({
  getFabricSettings: () => ({
    fabricApiBaseUrl: 'https://api.fabric.test/v1',
  }),
}));

vi.mock('../../../utils/http-client.js', () => ({
  fabricFetch: (...args: unknown[]) => fabricFetch(...args),
}));

vi.mock('../../../services/fabric/rayfin-item.js', () => ({
  RayfinItemManager: vi.fn().mockImplementation(() => ({
    getRayfinItemByName,
    getFabricItemById,
    createRayfinItem,
  })),
}));

import { RayfinItemManager } from '../../../services/fabric/rayfin-item.js';
import {
  createCliFabricClient,
  createCliFabricReadinessClient,
} from '../client.js';

const MockedRayfinItemManager = RayfinItemManager as unknown as ReturnType<
  typeof vi.fn
>;

class FakeHttp implements Http {
  public readonly calls: Array<{ input: string | URL; init?: RequestInit }> =
    [];

  private readonly responses: Response[];

  constructor(...responses: Response[]) {
    this.responses = responses;
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    this.calls.push({ input, init });
    const response = this.responses.shift();
    if (!response) {
      throw new Error('FakeHttp: no scripted response left');
    }
    return Promise.resolve(response);
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('createCliFabricClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fabricFetch.mockReset();
  });

  it('constructs the RayfinItemManager with the supplied token', () => {
    createCliFabricClient('bearer-123');

    expect(MockedRayfinItemManager).toHaveBeenCalledWith(
      'bearer-123',
      expect.objectContaining({
        log: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      })
    );
  });

  it('does not construct item operations for the readiness-only client', () => {
    createCliFabricReadinessClient('bearer-123');

    expect(MockedRayfinItemManager).not.toHaveBeenCalled();
  });

  it('constructs managers with silent output sinks', () => {
    createCliFabricClient('bearer-123');

    const output = MockedRayfinItemManager.mock.calls[0][1];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    output.log('created');
    output.warn('warning');
    output.error('error');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('constructs a fixed-token transport with the configured Fabric URL', async () => {
    fabricFetch.mockResolvedValueOnce(jsonResponse(200, { value: [] }));

    await createCliFabricClient('bearer-123').findTrialCapacity();

    expect(String(fabricFetch.mock.calls[0][0])).toBe(
      'https://api.fabric.test/v1/capacities'
    );
    const headers = fabricFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer bearer-123');
  });

  it('stops reading pages at the first trial capacity', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
          { id: 'trial', displayName: 'Trial', sku: 'FT1', state: 'Active' },
        ],
        continuationToken: 'next-page',
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).findTrialCapacity();

    expect(result?.id).toBe('trial');
    // The cursor is ignored once the answer is known; page two is never read.
    expect(http.calls).toHaveLength(1);
  });

  it('lists every accessible capacity for selection', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [{ id: 'f2', displayName: 'F2', sku: 'F2', state: 'Active' }],
        continuationToken: 'page-2',
      }),
      jsonResponse(200, {
        value: [
          { id: 'f4', displayName: 'F4', sku: 'F4', state: 'Active' },
          {
            id: 'trial',
            displayName: 'Trial',
            sku: 'FT1',
            state: 'Active',
          },
        ],
      })
    );

    const result = await createCliFabricReadinessClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).listCapacities();

    expect(result.map(({ id }) => id)).toEqual(['f2', 'f4', 'trial']);
    expect(http.calls[1].input).toBe(
      'https://api.fabric.test/v1/capacities?continuationToken=page-2'
    );
  });

  it('forwards the invocation signal to readiness requests', async () => {
    const controller = new AbortController();
    const http = new FakeHttp(jsonResponse(200, { value: [] }));

    await createCliFabricReadinessClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
      signal: controller.signal,
    }).findTrialCapacity();

    expect(http.calls[0].init?.signal).toBe(controller.signal);
  });

  it('follows the cursor when the trial is not on the first page', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
        continuationToken: 'tok+en/two=',
      }),
      jsonResponse(200, {
        value: [
          { id: 'trial', displayName: 'Trial', sku: 'FT1', state: 'Active' },
        ],
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).findTrialCapacity();

    expect(result?.id).toBe('trial');
    expect(http.calls.map(({ input }) => input)).toEqual([
      'https://api.fabric.test/v1/capacities',
      // The opaque cursor is percent-encoded; a raw `+` would arrive as a space.
      'https://api.fabric.test/v1/capacities?continuationToken=tok%2Ben%2Ftwo%3D',
    ]);
  });

  it('does not double-encode an already encoded continuation token', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
        continuationToken: 'LDEsMTAwMDAwLDA%3D',
      }),
      jsonResponse(200, {
        value: [
          { id: 'trial', displayName: 'Trial', sku: 'FT1', state: 'Active' },
        ],
      })
    );

    await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).findTrialCapacity();

    expect(http.calls[1].input).toBe(
      'https://api.fabric.test/v1/capacities?continuationToken=LDEsMTAwMDAwLDA%3D'
    );
  });

  it('resolves undefined when no page holds a trial capacity', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).findTrialCapacity();

    expect(result).toBeUndefined();
  });

  it('follows a continuation URI on the configured endpoint', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
        continuationUri:
          'https://api.fabric.test/v1/capacities?continuationToken=page-2',
      }),
      jsonResponse(200, {
        value: [
          { id: 'trial', displayName: 'Trial', sku: 'FT1', state: 'Active' },
        ],
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).findTrialCapacity();

    expect(result?.id).toBe('trial');
    expect(http.calls[1].input).toBe(
      'https://api.fabric.test/v1/capacities?continuationToken=page-2'
    );
  });

  it('uses the supplied token when a proxy receives a canonical continuation URI', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
        continuationUri:
          'https://api.fabric.microsoft.com/v1/capacities?continuationToken=page-2',
        continuationToken: 'page-2',
      }),
      jsonResponse(200, {
        value: [
          { id: 'trial', displayName: 'Trial', sku: 'FT1', state: 'Active' },
        ],
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://proxy.test/fabric/v1',
    }).findTrialCapacity();

    expect(result?.id).toBe('trial');
    expect(http.calls[1].input).toBe(
      'https://proxy.test/fabric/v1/capacities?continuationToken=page-2'
    );
  });

  it('rejects a continuation URI from another origin', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
        continuationUri:
          'https://attacker.example/v1/capacities?continuationToken=page-2',
      })
    );

    await expect(
      createCliFabricClient('t', {
        http,
        baseUrl: 'https://api.fabric.test/v1',
      }).findTrialCapacity()
    ).rejects.toThrow(/continuation URI does not match/);
    expect(http.calls).toHaveLength(1);
  });

  it('fails on the second page when the cursor repeats, not after the page cap', async () => {
    const stuckPage = () =>
      jsonResponse(200, {
        value: [
          { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
        ],
        continuationToken: 'same-token',
      });
    const http = new FakeHttp(stuckPage(), stuckPage(), stuckPage());

    await expect(
      createCliFabricClient('t', {
        http,
        baseUrl: 'https://api.fabric.test/v1',
      }).findTrialCapacity()
    ).rejects.toThrow(/repeated its continuation cursor/);
    expect(http.calls).toHaveLength(2);
  });

  it('terminates on a cursor that cycles past the page cap', async () => {
    // Distinct tokens defeat the repeated-cursor check, so only the page bound
    // can stop this. Reading past it would hang the CLI with no output.
    const http = new FakeHttp(
      ...Array.from({ length: 1001 }, (_unused, index) =>
        jsonResponse(200, {
          value: [
            { id: 'paid', displayName: 'Paid', sku: 'F2', state: 'Active' },
          ],
          continuationToken: `token-${index}`,
        })
      )
    );

    await expect(
      createCliFabricClient('t', {
        http,
        baseUrl: 'https://api.fabric.test/v1',
      }).findTrialCapacity()
    ).rejects.toThrow(/did not end after 1000 pages/);
    expect(http.calls).toHaveLength(1000);
  });

  it('checks trial eligibility with an empty POST', async () => {
    const http = new FakeHttp(
      jsonResponse(200, { eligible: true, reason: 'Eligible' })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).checkTrialEligibility();

    expect(result).toEqual({ eligible: true, reason: 'Eligible' });
    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/__private/capacities/checkTrialEligibility'
    );
    expect(http.calls[0].init?.method).toBe('POST');
    expect(http.calls[0].init?.body).toBeUndefined();
  });

  it('starts a trial without automatic operation polling', async () => {
    const http = new FakeHttp(
      jsonResponse(
        202,
        {},
        {
          Location: 'https://api.fabric.test/v1/operations/op-1',
          'x-ms-operation-id': 'op-1',
          'Retry-After': '7',
        }
      )
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).startTrial();

    expect(result).toEqual({
      operationId: 'op-1',
      operationLocation: 'https://api.fabric.test/v1/operations/op-1',
      retryAfterMs: 7_000,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/__private/capacities'
    );
    expect(http.calls[0].init?.body).toBe(
      JSON.stringify({ type: 'FabricTrialCapacity' })
    );
  });

  it('gets operation status using the service-provided location', async () => {
    const http = new FakeHttp(
      jsonResponse(200, { status: 'Running', error: null })
    );
    const client = createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    });

    const result = await client.getOperationStatus(
      'https://api.fabric.test/v1/operations/op-1'
    );

    expect(result).toEqual({ status: 'Running', error: null });
    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/operations/op-1'
    );
  });

  it('accepts a documented unversioned operation location', async () => {
    const http = new FakeHttp(jsonResponse(200, { status: 'Running' }));
    const client = createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    });

    await client.getOperationStatus('https://api.fabric.test/operations/op-1');

    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/operations/op-1'
    );
  });

  it('polls a canonical operation through the configured proxy', async () => {
    const http = new FakeHttp(jsonResponse(200, { status: 'Running' }));
    const client = createCliFabricClient('t', {
      http,
      baseUrl: 'https://proxy.test/fabric/v1',
    });

    await client.getOperationStatus(
      'https://api.fabric.microsoft.com/v1/operations/op-1',
      'op-1'
    );

    expect(http.calls[0].input).toBe(
      'https://proxy.test/fabric/v1/operations/op-1'
    );
  });

  it('rejects an operation location from another origin', async () => {
    const http = new FakeHttp();
    const client = createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    });

    await expect(
      client.getOperationStatus('https://attacker.example/operations/op-1')
    ).rejects.toThrow(/does not match the configured API endpoint/);
    expect(http.calls).toHaveLength(0);
  });

  it('gets an operation result by encoded operation id', async () => {
    const http = new FakeHttp(jsonResponse(200, { id: 'capacity-1' }));

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).getOperationResult<{ id: string }>('op/1');

    expect(result).toEqual({ id: 'capacity-1' });
    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/operations/op%2F1/result'
    );
  });

  it('creates a workspace without assigning capacity', async () => {
    const workspace = {
      id: 'w2',
      displayName: 'My App',
    };
    const http = new FakeHttp(jsonResponse(201, workspace));

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).createWorkspace('My App');

    expect(result).toEqual(workspace);
    expect(http.calls[0].input).toBe('https://api.fabric.test/v1/workspaces');
    expect(http.calls[0].init?.body).toBe(
      JSON.stringify({ displayName: 'My App' })
    );
  });

  it('assigns an existing workspace to a capacity', async () => {
    const http = new FakeHttp(
      new Response(null, {
        status: 202,
        headers: { 'Retry-After': '6' },
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).assignWorkspaceToCapacity('workspace/1', 'c1');

    expect(result).toEqual({ retryAfterMs: 6_000 });
    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/workspaces/workspace%2F1/assignToCapacity'
    );
    expect(http.calls[0].init?.body).toBe(JSON.stringify({ capacityId: 'c1' }));
  });

  it('does not poll the assignment operation the readiness step verifies', async () => {
    // Fabric may return a Location on assign; following it here would poll the
    // same completion the readiness step already polls on the workspace.
    const http = new FakeHttp(
      new Response(null, {
        status: 202,
        headers: { Location: 'https://api.fabric.test/v1/operations/op-9' },
      })
    );

    await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).assignWorkspaceToCapacity('ws-1', 'c1');

    expect(http.calls).toHaveLength(1);
  });

  it('reads every page of workspaces from the shared transport', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [{ id: 'w1', displayName: 'One' }],
        continuationToken: 'page-2',
      }),
      jsonResponse(200, { value: [{ id: 'w2', displayName: 'Two' }] })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).listWorkspaces();

    expect(result).toEqual([
      { id: 'w1', displayName: 'One' },
      { id: 'w2', displayName: 'Two' },
    ]);
    expect(http.calls[1].input).toBe(
      'https://api.fabric.test/v1/workspaces?continuationToken=page-2'
    );
  });

  it('reports Admin access without reading past the matching page', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [{ id: 'w-admin', displayName: 'Admin Workspace' }],
        continuationToken: 'page-2',
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).isWorkspaceAdmin('w-admin');

    expect(result).toBe(true);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/workspaces?roles=Admin'
    );
  });

  it('reports missing Admin access after exhausting every page', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [{ id: 'w-other', displayName: 'Other' }],
        continuationToken: 'page-2',
      }),
      jsonResponse(200, { value: [{ id: 'w-more', displayName: 'More' }] })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).isWorkspaceAdmin('w-admin');

    expect(result).toBe(false);
    expect(http.calls).toHaveLength(2);
  });

  it('finds Admin access on a later page', async () => {
    const http = new FakeHttp(
      jsonResponse(200, {
        value: [{ id: 'w-other', displayName: 'Other' }],
        continuationToken: 'page-2',
      }),
      jsonResponse(200, {
        value: [{ id: 'w-admin', displayName: 'Admin Workspace' }],
      })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).isWorkspaceAdmin('w-admin');

    expect(result).toBe(true);
    expect(http.calls[1].input).toBe(
      'https://api.fabric.test/v1/workspaces?roles=Admin&continuationToken=page-2'
    );
  });

  it('gets a workspace by encoded id from the shared transport', async () => {
    const http = new FakeHttp(
      jsonResponse(200, { id: 'workspace/1', displayName: 'One' })
    );

    const result = await createCliFabricClient('t', {
      http,
      baseUrl: 'https://api.fabric.test/v1',
    }).getWorkspace('workspace/1');

    expect(http.calls[0].input).toBe(
      'https://api.fabric.test/v1/workspaces/workspace%2F1'
    );
    expect(result).toEqual({ id: 'workspace/1', displayName: 'One' });
  });

  it('delegates getItemByName to the item manager', async () => {
    const found = { id: 'i1', displayName: 'my-app' };
    getRayfinItemByName.mockResolvedValue(found);

    const result = await createCliFabricClient('t').getItemByName(
      'w1',
      'my-app'
    );

    expect(getRayfinItemByName).toHaveBeenCalledWith('w1', 'my-app');
    expect(result).toBe(found);
  });

  it('delegates getCliFabricItemById to the item manager', async () => {
    const found = { id: 'i1', displayName: 'my-app' };
    getFabricItemById.mockResolvedValue(found);
    const { getCliFabricItemById } = await import('../client.js');

    const result = await getCliFabricItemById('token', 'w1', 'i1');

    expect(result).toBe(found);
    expect(getFabricItemById).toHaveBeenCalledWith('w1', 'i1');
  });

  it('delegates createItem to the item manager', async () => {
    const created = { id: 'i2', displayName: 'my-app' };
    createRayfinItem.mockResolvedValue(created);

    const result = await createCliFabricClient('t').createItem('w1', 'my-app');

    expect(createRayfinItem).toHaveBeenCalledWith('w1', 'my-app');
    expect(result).toBe(created);
  });
});
