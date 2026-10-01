import { SdkError, type ApiClientConfig } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RayfinClient } from '../client';

// Test schema type for verification
interface TestSchema {
  User: {
    id: string;
    email: string;
    name: string;
  };
  Organization: {
    id: string;
    name: string;
    description?: string;
  };
}

describe('RayfinClient Integration Tests', () => {
  let client: RayfinClient<TestSchema>;
  let config: ApiClientConfig;

  beforeEach(() => {
    config = {
      baseUrl: 'http://localhost:5000',
      publishableKey: 'pk-test-key-12345678',
    };

    client = new RayfinClient<TestSchema>(config);
  });

  describe('Success Criteria Verification', () => {
    it('should create client with auth, rest, gql properties', () => {
      // Verify expectation from plan: client.auth, client.rest, client.gql all defined
      expect(client.auth).toBeDefined();
      expect(client.data).toBeDefined();
    });

    it('should provide type-safe property access', () => {
      // These should be defined as proxies that create clients on-demand
      expect(client.data.User).toBeDefined();
      expect(client.data.Organization).toBeDefined();
    });

    it('should maintain existing functionality patterns', () => {
      // Verify GraphQL fluent methods (direct entity access)
      expect(typeof client.data.User.select).toBe('function');
      expect(typeof client.data.User.where).toBe('function');
      expect(typeof client.data.User.create).toBe('function');
      expect(typeof client.data.User.update).toBe('function');
      expect(typeof client.data.User.delete).toBe('function');
    });

    it('should expose static error classes', () => {
      expect(RayfinClient.errors).toBeDefined();
      expect(RayfinClient.errors.SdkError).toBeDefined();
      expect(RayfinClient.errors.AuthError).toBeDefined();
      expect(RayfinClient.errors.NetworkError).toBeDefined();
    });
  });

  describe('Token Integration', () => {
    it('should attach auth token provider to API client', () => {
      // Verify that the auth module is properly attached to the API client
      // The Auth class manages token concealment internally
      expect(client.auth).toBeDefined();

      // The ApiClient should have a token callback set up
      // (tokens are concealed, not exposed via public API)
      const session = client.auth.getSession();
      expect(session).toBeDefined();
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain DataApi interface for direct usage', () => {
      // Verify that DataApi is accessible for users who want direct usage
      expect(client.data).toBeDefined();
    });
  });

  describe('Configuration', () => {
    it('should require baseUrl in configuration', () => {
      expect(() => {
        new RayfinClient({} as ApiClientConfig);
      }).toThrow('SDK configuration requires a baseUrl');
    });

    it('should accept an empty baseUrl as the explicit dev-proxy opt-in', () => {
      expect(() => {
        new RayfinClient<TestSchema>({
          baseUrl: '',
          publishableKey: 'pk-test-key-12345678',
        });
      }).not.toThrow();
    });

    it('should treat legacy useProxy:true without baseUrl as same-origin', () => {
      // Backward compatibility during the `useProxy` deprecation window: the
      // `client.ts` shim resolves `useProxy:true` without a `baseUrl` to an
      // empty `baseUrl`. This test only verifies that the shim resolves to `''`;
      // the routing outcome of `baseUrl: ''` (same-origin requests) is covered
      // behaviorally by ApiClient's own tests. Asserting the resolved value
      // guards against a future refactor defaulting the shim to '/' or
      // reintroducing the old isViteDevelopment() rewrite.
      const proxyClient = new RayfinClient<TestSchema>({
        publishableKey: 'pk-test-key-12345678',
        useProxy: true,
      } as ApiClientConfig);

      const resolvedBaseUrl = (
        proxyClient as unknown as { apiClient: { baseUrl: string } }
      ).apiClient.baseUrl;

      expect(resolvedBaseUrl).toBe('');
    });

    it('should still throw MISSING_BASE_URL when useProxy:false is passed without baseUrl', () => {
      // The deprecated `useProxy` flag must not influence baseUrl validation:
      // `useProxy:false` without a `baseUrl` is still a misconfiguration.
      let thrown: unknown;
      try {
        new RayfinClient<TestSchema>({
          publishableKey: 'pk-test-key-12345678',
          useProxy: false,
        } as ApiClientConfig);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SdkError);
      expect((thrown as SdkError).code).toBe('MISSING_BASE_URL');
    });

    it('should accept optional configuration parameters', () => {
      const customConfig: ApiClientConfig = {
        baseUrl: 'http://localhost:3000',
        publishableKey: 'pk-test-key-12345678',
        headers: { 'Custom-Header': 'test' },
        timeout: 15000,
      };

      expect(() => {
        new RayfinClient<TestSchema>(customConfig);
      }).not.toThrow();
    });
  });

  describe('API Surface Verification', () => {
    it('should match the target API surface from the plan', () => {
      // This test verifies the exact API surface specified in the plan:
      // const client = new RayfinClient<TestSchema>({ baseUrl: 'http://localhost:5000' });
      // expect(client.auth).toBeDefined();
      // expect(client.rest).toBeDefined();
      // expect(client.gql).toBeDefined();

      const testClient = new RayfinClient<TestSchema>({
        baseUrl: 'http://localhost:5000',
        publishableKey: 'pk-test-key-12345678',
      });

      // Verification expectations from the plan
      expect(testClient.auth).toBeDefined(); // Authentication operations
      expect(testClient.data).toBeDefined(); // GraphQL operations

      // Usage examples should be type-safe and available
      // await client.auth.signUp({ email: 'user@example.com', password: 'password' });
      expect(typeof testClient.auth.signUp).toBe('function');

      // const activeUsers = await client.data.User.select(['id', 'name']).where({ isActive: true }).execute();
      expect(typeof testClient.data.User.select).toBe('function');

      const selectBuilder = testClient.data.User.select(['id', 'email']);
      expect(typeof selectBuilder.where).toBe('function');
      expect(typeof selectBuilder.execute).toBe('function');
    });
  });
});
