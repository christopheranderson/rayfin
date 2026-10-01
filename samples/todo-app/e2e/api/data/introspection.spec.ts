import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startBackend, stopBackend, getBackendUrl } from '../../shared/backend';

/**
 * E2E coverage for the CWE-200 fix: GraphQL schema introspection must be
 * disabled by default for projects that do not opt in via
 * `services.data.allowIntrospection: true` in `rayfin.yml`.
 *
 * The todo-app's `rayfin.yml` does not set `allowIntrospection`, so the
 * backend should reject introspection queries that arrive with only a
 * publishable key (no JWT) — matching the original attacker model where a
 * 3P-pen-tester observed full schema disclosure on a separate DAB artifact.
 */
describe('GraphQL Introspection (secure default)', () => {
  const RAYFIN_PUBLISHABLE_KEY = 'pk-commonSampleAppPKkey';

  beforeAll(async () => {
    await startBackend();
  });

  afterAll(async () => {
    await stopBackend();
  });

  /**
   * Issue a raw GraphQL POST with only the publishable key (no Authorization
   * header). Returns the parsed response so individual tests can assert on
   * either `data` or `errors`.
   */
  async function postGraphQL(query: string): Promise<{
    status: number;
    body: {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
    };
  }> {
    const response = await fetch(`${getBackendUrl()}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Publishable-Key': RAYFIN_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({ query }),
    });
    return { status: response.status, body: await response.json() };
  }

  /**
   * Assert that a GraphQL response did not return any introspection data and
   * that any returned error is the HotChocolate "introspection not allowed"
   * signal — not, e.g., a syntax error masking the real behavior.
   */
  function expectIntrospectionRejected(body: {
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  }): void {
    // No introspection payload should be returned to the caller.
    expect(body.data?.__schema).toBeFalsy();
    expect(body.data?.__type).toBeFalsy();

    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);

    // HotChocolate surfaces introspection denial via a known error message /
    // code. Match loosely so minor version bumps don't break the suite, but
    // require at least one signal of intentional denial (not a generic 500).
    const denialSignal = body.errors!.some((err) => {
      const message = (err.message ?? '').toLowerCase();
      const code = String(err.extensions?.code ?? '').toLowerCase();
      return (
        message.includes('introspection') ||
        code.includes('introspection') ||
        message.includes('not allowed') ||
        message.includes('disabled')
      );
    });
    expect(
      denialSignal,
      `Expected an introspection-denial error; got: ${JSON.stringify(body.errors)}`
    ).toBe(true);
  }

  it('rejects __schema introspection when called with only a publishable key', async () => {
    const { body } = await postGraphQL(`
      query {
        __schema {
          types { name }
        }
      }
    `);

    expectIntrospectionRejected(body);
  });

  it('rejects __type introspection when called with only a publishable key', async () => {
    const { body } = await postGraphQL(`
      query {
        __type(name: "Todo") {
          name
          fields { name }
        }
      }
    `);

    expectIntrospectionRejected(body);
  });

  it('rejects the full introspection query used by tooling (e.g. GraphiQL)', async () => {
    // Abbreviated form of the standard introspection query that IDE clients
    // send to auto-discover the schema. The full version would also work, but
    // this is enough to confirm the fail-closed default.
    const { body } = await postGraphQL(`
      query IntrospectionQuery {
        __schema {
          queryType { name }
          mutationType { name }
          types {
            kind
            name
            fields { name }
          }
        }
      }
    `);

    expectIntrospectionRejected(body);
  });

  it('still serves normal data queries while introspection is disabled', async () => {
    // Sanity check: disabling introspection must not break regular queries.
    // We expect either successful data or a non-introspection error (e.g.
    // auth-related), but never an introspection-denial error.
    const { body } = await postGraphQL(`
      query {
        todos(first: 1) {
          items { id }
        }
      }
    `);

    const introspectionDenial = (body.errors ?? []).some((err) =>
      (err.message ?? '').toLowerCase().includes('introspection')
    );
    expect(
      introspectionDenial,
      'A normal data query should not be reported as an introspection error.'
    ).toBe(false);
  });

  /**
   * Hot-toggle scenario: a project owner flips `services.data.allowIntrospection`
   * via `POST /api/projectRuntimeSettings` (what `rayfin dev apply` does). The
   * change must take effect against the SAME running webservice — no restart.
   *
   * Why this matters: `GraphQLQueryWorkflow` caches one `IRequestExecutor` per
   * (tenant, project, schemaVersion, introspectionFlag) tuple. If the flag
   * weren't part of the cache key, the first request after a toggle would hit
   * the stale executor and the toggle would appear to be ignored until the
   * service restarted. This test exercises both directions of the toggle to
   * lock in that invariant.
   */
  it('honors hot toggling of allowIntrospection without a service restart', async () => {
    const settingsUrl = `${getBackendUrl()}/api/projectRuntimeSettings`;
    const pkHeader = { 'x-rayfin-publishable-key': RAYFIN_PUBLISHABLE_KEY };

    // Snapshot the current runtime settings so we can restore them at the end
    // regardless of test outcome. The GET response wraps ServiceSettings under
    // `serviceSettings`; POST accepts ServiceSettings at the top level.
    const initialResponse = await fetch(settingsUrl, { headers: pkHeader });
    expect(initialResponse.ok).toBe(true);
    const initial = await initialResponse.json();
    const originalServiceSettings = initial.serviceSettings;

    async function applyAllowIntrospection(allow: boolean): Promise<void> {
      const next = {
        ...originalServiceSettings,
        data: { ...originalServiceSettings.data, allowIntrospection: allow },
      };
      const res = await fetch(settingsUrl, {
        method: 'POST',
        headers: { ...pkHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      expect(
        res.ok,
        `POST /api/projectRuntimeSettings failed with ${res.status}: ${await res
          .text()
          .catch(() => '<no body>')}`
      ).toBe(true);
    }

    try {
      // 1. Toggle ON — introspection should now succeed on the SAME process.
      await applyAllowIntrospection(true);
      const enabled = await postGraphQL(`
        query {
          __schema {
            queryType { name }
          }
        }
      `);
      expect(
        enabled.body.errors,
        `Expected introspection to succeed after enabling; got: ${JSON.stringify(
          enabled.body.errors
        )}`
      ).toBeUndefined();
      expect(enabled.body.data?.__schema).toBeTruthy();

      // 2. Toggle OFF — introspection must be denied again without restart.
      await applyAllowIntrospection(false);
      const disabled = await postGraphQL(`
        query {
          __schema {
            queryType { name }
          }
        }
      `);
      expectIntrospectionRejected(disabled.body);

      // 3. And normal data queries must keep working through both flips
      // (regression guard for the IProjectContext re-access bug).
      const normal = await postGraphQL(`
        query {
          todos(first: 1) {
            items { id }
          }
        }
      `);
      const stillBroken = (normal.body.errors ?? []).some((err) =>
        (err.message ?? '').toLowerCase().includes('introspection')
      );
      expect(stillBroken).toBe(false);
    } finally {
      // Always restore the original settings so subsequent tests/runs are
      // not polluted by this test.
      await fetch(settingsUrl, {
        method: 'POST',
        headers: { ...pkHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(originalServiceSettings),
      });
    }
  });
});
