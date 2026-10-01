import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GraphQLClient } from '../graphql/GraphQLClient';
import { GraphQLQueryBuilder } from '../graphql/GraphQLQueryBuilder';

// Test entity types
type User = {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  age: number;
  role: string;
  created_at: Date;
  manager?: User;
  posts: Post[];
};

type Post = {
  id: string;
  title: string;
  content: string;
  user_id: number;
};

type TestSchema = {
  User: User;
  Post: Post;
};

describe('GraphQLQueryBuilder', () => {
  let mockGraphQLClient: GraphQLClient;
  let builder: GraphQLQueryBuilder<TestSchema, 'User'>;

  beforeEach(() => {
    mockGraphQLClient = {
      query: vi.fn(),
      mutation: vi.fn(),
      request: vi.fn(),
    } as any;

    builder = new GraphQLQueryBuilder(mockGraphQLClient, 'User');
  });

  describe('Field Selection', () => {
    it('should wrap nested selections for plural navigation fields under items', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      await builder.select(['id', 'posts.id', 'posts.title']).execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('posts');
      expect(call).toContain('items');
      expect(call).toContain('id');
      expect(call).toContain('title');
    });
  });

  describe('Fluent Interface', () => {
    it('should chain select methods', () => {
      const result = builder
        .select(['id', 'email', 'full_name'])
        .where({ is_active: { eq: true } })
        .orderBy({ created_at: 'desc' })
        .first(10)
        .after('cursor123');

      expect(result).toBe(builder);
      expect(typeof result.execute).toBe('function');
    });

    it('should build query with selections', () => {
      const result = builder.select(['id', 'email', 'full_name']);
      expect(result).toBe(builder);
    });

    it('should build query with where conditions', () => {
      const result = builder.where({
        is_active: { eq: true },
        age: { gte: 18 },
      });
      expect(result).toBe(builder);
    });

    it('should build query with ordering', () => {
      const result = builder.orderBy({ created_at: 'desc', full_name: 'asc' });
      expect(result).toBe(builder);
    });

    it('should build query with pagination', () => {
      const result = builder.first(20).after('cursor456');
      expect(result).toBe(builder);
    });
  });

  describe('Query Execution', () => {
    it('should execute basic query', async () => {
      const mockUsers = [
        { id: 1, email: 'user1@example.com', full_name: 'User 1' },
        { id: 2, email: 'user2@example.com', full_name: 'User 2' },
      ];

      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: mockUsers },
        },
      });

      const result = await builder
        .select(['id', 'email', 'full_name'])
        .execute();

      expect(mockGraphQLClient.query).toHaveBeenCalledWith(
        expect.stringContaining('query')
      );
      expect(result).toEqual(mockUsers);
    });

    it('should execute query with complex where conditions', async () => {
      const mockUsers = [{ id: 1, email: 'admin@example.com', role: 'admin' }];

      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: mockUsers },
        },
      });

      const result = await builder
        .select(['id', 'email', 'role'])
        .where({
          or: [
            { role: { eq: 'admin' } },
            {
              and: [{ role: { eq: 'user' } }, { age: { gte: 18 } }],
            },
          ],
        })
        .execute();

      expect(result).toEqual(mockUsers);
    });

    it('should execute findFirst() query', async () => {
      const mockUser = { id: 1, email: 'user@example.com', full_name: 'User' };

      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [mockUser] },
        },
      });

      const result = await builder
        .select(['id', 'email', 'full_name'])
        .where({ id: { eq: '1' } })
        .findFirst();

      expect(result).toEqual(mockUser);
    });

    it('should return null for findFirst() when no results', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      const result = await builder.where({ id: { eq: '999' } }).findFirst();

      expect(result).toBeNull();
    });

    it('should execute executePaginated() and return paged result', async () => {
      const mockUsers = [{ id: 1 }, { id: 2 }];
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: {
            items: mockUsers,
            hasNextPage: true,
            endCursor: 'b',
          },
        },
      });

      const result = await builder.select(['id']).executePaginated();

      expect(mockGraphQLClient.query).toHaveBeenCalled();
      expect(result.items).toEqual(mockUsers);
      expect(result.hasNextPage).toBe(true);
      expect(result.endCursor).toBe('b');
      // DAB doesn't return totalCount in paginated queries
      expect(result.totalCount).toBeUndefined();
    });

    it('unwraps nested connection items in executePaginated()', async () => {
      const mockUsers = [
        {
          id: 1,
          posts: {
            items: [
              { id: 11, title: 'p1' },
              { id: 12, title: 'p2' },
            ],
          },
        },
      ];

      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: {
            items: mockUsers,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        },
      });

      const result = await builder
        .select(['id', 'posts.id', 'posts.title'])
        .executePaginated();

      expect(Array.isArray(result.items[0].posts)).toBe(true);
      expect(result.items[0].posts).toHaveLength(2);
      expect(result.items[0].posts[0]).toMatchObject({ id: 11, title: 'p1' });
    });
  });
  describe('Filter Building', () => {
    it('should build simple equality filters', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      await builder
        .where({
          is_active: { eq: true },
          role: { eq: 'admin' },
          age: { eq: 25 },
        })
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('filter:');
      expect(call).toContain('is_active: { eq: true }');
      expect(call).toContain('role: { eq: "admin" }');
      expect(call).toContain('age: { eq: 25 }');
    });

    it('should map relationship isNull filters to foreign key fields', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      await builder
        .select(['id', 'manager.id'])
        .where({ manager: { isNull: true } })
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('manager_id: { isNull: true }');
      expect(call).not.toContain('manager: { isNull: true }');
    });

    it('should build complex operator-based and logical filters', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      await builder
        .where({
          age: { gte: 18, lt: 65 },
          or: [{ role: { eq: 'admin' } }, { role: { eq: 'user' } }],
          and: [
            { email: { contains: '@company.com' } },
            { is_active: { eq: true } },
          ],
        })
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('age: { gte: 18, lt: 65 }');
      expect(call).toContain(
        'or: [{ role: { eq: "admin" } }, { role: { eq: "user" } }]'
      );
      expect(call).toContain('and: [');
      expect(call).toContain('email: { contains: "@company.com" }');
    });

    it('should handle date filters and quote escaping', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      const testDate = new Date('2024-01-01T00:00:00Z');

      await builder
        .where({
          created_at: { gte: testDate },
          full_name: { eq: "O'Connor" },
        })
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('created_at: { gte: "2024-01-01T00:00:00.000Z" }');
      expect(call).toContain('full_name: { eq: "O\'Connor" }');
    });
  });

  describe('Ordering', () => {
    it('should build order by clauses', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      await builder
        .orderBy({
          created_at: 'desc',
          full_name: 'asc',
          age: 'desc',
        })
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('orderBy:');
      expect(call).toContain('created_at: DESC');
      expect(call).toContain('full_name: ASC');
      expect(call).toContain('age: DESC');
    });
  });

  describe('Pagination', () => {
    it('should include pagination parameters', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      await builder.first(25).after('cursor123').execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('first: 25');
      expect(call).toContain('after: "cursor123"');
    });
  });

  describe('Error Handling', () => {
    it('should handle empty results gracefully', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          users: { items: [] },
        },
      });

      const result = await builder.execute();
      expect(result).toEqual([]);
    });

    it('should handle malformed responses', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: {
          // Missing expected structure
          wrongField: [],
        },
      });

      // Should throw error due to ResponseHandler validation
      await expect(builder.execute()).rejects.toThrow();
    });

    it('should handle null/undefined responses', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue(null);

      // Should throw error due to ResponseHandler validation
      await expect(builder.execute()).rejects.toThrow();
    });
  });

  describe('Value Escaping', () => {
    it('should escape backslashes in string filter values', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: [] } },
      });

      await builder
        .where({ full_name: { eq: 'path\\to\\file' } } as any)
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('path\\\\to\\\\file');
    });

    it('should escape double quotes in string filter values', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: [] } },
      });

      await builder
        .where({ full_name: { eq: 'he said "hello"' } } as any)
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('he said \\"hello\\"');
    });

    it('should escape newlines and tabs in string filter values', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: [] } },
      });

      await builder
        .where({ full_name: { eq: 'line1\nline2\ttab' } } as any)
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('line1\\nline2\\ttab');
    });

    it('should escape carriage returns in string filter values', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: [] } },
      });

      await builder
        .where({ full_name: { eq: 'line1\r\nline2' } } as any)
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('line1\\r\\nline2');
    });

    it('should handle combined special characters', async () => {
      (mockGraphQLClient.query as any).mockResolvedValue({
        data: { users: { items: [] } },
      });

      await builder
        .where({
          full_name: { eq: 'a\\b"c\nd\te' },
        } as any)
        .execute();

      const call = (mockGraphQLClient.query as any).mock.calls[0][0];
      expect(call).toContain('a\\\\b\\"c\\nd\\te');
    });
  });
});
