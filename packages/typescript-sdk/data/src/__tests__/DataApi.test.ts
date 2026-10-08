import type { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, vi, beforeEach, expectTypeOf } from 'vitest';

import { createDataApi, DataApi } from '../index';

// Test entity types
type User = {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  created_at: Date;
};

type Organization = {
  id: string;
  name: string;
  description?: string;
  is_private: boolean;
  created_at: Date;
};

type Event = {
  id: string;
  name: string;
  description?: string;
  start_time: Date;
  end_time: Date;
  organization_id: number;
  created_at: Date;
};

type MySchema = {
  User: User;
  Organization: Organization;
  Event: Event;
};

function createMockApiClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  } as any;
}

describe('DataApi', () => {
  let mockApiClient: ApiClient;
  let client: ReturnType<typeof createDataApi<MySchema>>;

  beforeEach(() => {
    mockApiClient = createMockApiClient();
    client = createDataApi<MySchema>(mockApiClient);
  });

  describe('Type Safety and Client Creation', () => {
    it('should create type-safe GraphQL clients', () => {
      // Access entities to populate cache

      // Verify GraphQL clients
      expect(client.User).toBeDefined();
      expect(client.Organization).toBeDefined();
      expect(client.Event).toBeDefined();

      // Verify entity discovery
      const entities = client.getEntityNames();
      expect(entities).toContain('User');
      expect(entities).toContain('Organization');
    });

    it('should provide type-safe method signatures', () => {
      const userClient = client.User;

      // GraphQL methods
      expect(typeof userClient.select).toBe('function');
      expect(typeof userClient.where).toBe('function');
      expect(typeof userClient.orderBy).toBe('function');
      expect(typeof userClient.first).toBe('function');
      expect(typeof userClient.create).toBe('function');
      expect(typeof userClient.update).toBe('function');
      expect(typeof userClient.delete).toBe('function');
      expect(typeof userClient.upsert).toBe('function');
    });

    it('should return only entity names in ownKeys, not class methods', () => {
      // Get the keys via Object.keys()
      // First access some entities to populate the cache
      const _user = client.User;
      const _organization = client.Organization;
      const keys = Object.keys(client);

      // Should contain entity names
      expect(keys).toContain('User');
      expect(keys).toContain('Organization');

      // Should NOT contain class method names
      expect(keys).not.toContain('constructor');
      expect(keys).not.toContain('getClient');
      expect(keys).not.toContain('getEntityNames');
      expect(keys).not.toContain('createProxy');
      expect(keys).not.toContain('apiClient');
      expect(keys).not.toContain('clientCache');

      // Should only have entity names (verify length)
      expect(keys.length).toBe(2);
    });

    it('should reject invalid entity names at compile time', () => {
      // TypeScript type-level assertion: valid entities exist
      expectTypeOf(client).toHaveProperty('User');
      expectTypeOf(client).toHaveProperty('Organization');
      expectTypeOf(client).toHaveProperty('Event');

      // TypeScript type-level assertion: invalid entities don't exist, and Typescript
      // raises a compile-time error if uncommented, but at runtime we can still access via Proxy...
      // @ts-expect-error - NonExistentEntity is not in MySchema
      expectTypeOf(client).toHaveProperty('NonExistentEntity');

      // Runtime verification: accessing an invalid entity creates a client,
      // but TypeScript prevents this code from compiling without @ts-expect-error
      // @ts-expect-error - NonExistentEntity is not in MySchema
      const invalidClient = client.NonExistentEntity;
      expect(invalidClient).toBeDefined();
    });
  });
});

/**
 * This file demonstrates the IMPROVED type safety for the GraphQL fluent interface.
 *
 * The select() method now only accepts valid entity field names and nested field paths.
 * The examples below show what works and what should cause TypeScript compilation errors.
 * To test the error cases, uncomment the "❌ Should fail" examples and see TypeScript errors.
 *
 * ✅ IMPROVEMENTS MADE:
 * - select() method is now fully type-safe - only accepts valid field names
 * - Nested field paths are supported (e.g., 'posts.title')
 * - Clean type definitions exclude inherited prototype methods
 * - Clear TypeScript error messages when invalid fields are used
 * - IntelliSense provides autocomplete for valid field names
 */

type Post = {
  id: string;
  title: string;
  content: string;
  user_id: number;
  created_at: Date;
  category: Category;
};

type Category = {
  id: string;
  name: string;
  color: ColorX;
};

type ColorX = {
  name: string;
};

// Define schema
type AppSchema = {
  User: User;
  Post: Post;
};

// Mock ApiClient for testing
const mockApiClient: ApiClient = {
  get: async () => ({ data: [] }),
  post: async () => ({ data: {} }),
  put: async () => ({ data: {} }),
  delete: async () => ({ data: {} }),
  patch: async () => ({ data: {} }),
} as any;

// Create typed client
const client = createDataApi<AppSchema>(mockApiClient);

// ✅ THESE WORK - Type-safe field selections
const validExamples = () => {
  // Valid User fields

  // Valid Post fields
  client.Post.select(['id']);
  client.Post.select(['title']);
  client.Post.select(['content']);
  client.Post.select(['user_id']);
  client.Post.select(['id', 'title', 'content', 'category.color']);
};
