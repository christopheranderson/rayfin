import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDataApi } from '../client/DataApi';

type User = {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  age: number;
  role: string;
  created_at: Date;
  posts: Post[];
  organization: Organization;
};

type Post = {
  id: string;
  title: string;
  content: string;
  user_id: number;
  created_at: Date;
};

type Organization = {
  id: string;
  name: string;
  description?: string;
  is_private: boolean;
  created_at: Date;
};

type AppSchema = {
  User: User;
  Post: Post;
  Organization: Organization;
};

describe('GraphQL Fluent Interface', () => {
  let apiClient: ApiClient;
  let dataApi: ReturnType<typeof createDataApi<AppSchema>>;

  beforeEach(() => {
    apiClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as any;

    dataApi = createDataApi<AppSchema>(apiClient);
  });

  describe('Core Functionality', () => {
    it('should provide GraphQL interface with proper methods', () => {
      const userClient = dataApi.User;

      // Verify essential methods exist
      expect(typeof userClient.select).toBe('function');
      expect(typeof userClient.where).toBe('function');
      expect(typeof userClient.create).toBe('function');
    });

    it('should support complete fluent query building', () => {
      const queryBuilder = dataApi.User.select([
        'id',
        'email',
        'full_name',
        'posts.title',
      ])
        .where({
          is_active: true,
          age: { gte: 18 },
          role: { in: ['admin', 'user'] },
          organization: { id: '1' },
        })
        .where({
          or: [{ full_name: { eq: 'rayfin' } }, { full_name: { eq: 'user' } }],
        })
        .orderBy({ created_at: 'desc', full_name: 'asc' })
        .first(20)
        .after('cursor10');

      expect(typeof queryBuilder.execute).toBe('function');
      expect(typeof queryBuilder.where).toBe('function'); // Should allow continued chaining
    });

    it('should support multiple query starting points', () => {
      // Test that all builder methods return chainable builders
      const selectFirst = dataApi.User.select(['id', 'email']);
      const whereFirst = dataApi.User.where({ is_active: { eq: true } });
      const orderFirst = dataApi.User.orderBy({ created_at: 'desc' });

      [selectFirst, whereFirst, orderFirst].forEach((builder) => {
        expect(typeof builder.execute).toBe('function');
        expect(typeof builder.where).toBe('function');
        expect(typeof builder.select).toBe('function');
      });
    });

    it('should provide direct mutation methods', () => {
      const userClient = dataApi.User;

      expect(typeof userClient.create).toBe('function');
      expect(typeof userClient.update).toBe('function');
      expect(typeof userClient.delete).toBe('function');
      expect(typeof userClient.upsert).toBe('function');
    });
  });
});
