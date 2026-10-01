import { describe, it, expect, vi } from 'vitest';

import type { GraphQLClient } from '../../graphql/GraphQLClient';

import { TestableGraphQLQueryBuilder } from './TestableGraphQLQueryBuilder';
import { compareQueries, validateDABCompliance } from './query-utils';
import type { TestSchema } from './sample-models';

const createBuilder = () => {
  const mockGraphQLClient = {
    query: vi.fn(),
    mutation: vi.fn(),
    request: vi.fn(),
  } as any;

  return new TestableGraphQLQueryBuilder<TestSchema, 'Todo'>(
    mockGraphQLClient,
    'Todo'
  );
};

describe('GraphQL Query Validation', () => {
  it('should generate correct DAB-compliant GraphQL query for complex Todo query', () => {
    // Arrange
    const mockGraphQLClient: GraphQLClient = {
      query: vi.fn(),
      mutation: vi.fn(),
      request: vi.fn(),
    } as any;

    const builder = new TestableGraphQLQueryBuilder<TestSchema, 'Todo'>(
      mockGraphQLClient,
      'Todo'
    );

    // Act - Build complex query with all major features
    const actualQuery = builder
      .select([
        'id',
        'title',
        'description',
        'isCompleted',
        'priority',
        'dueDate',
        'category.name',
        'category.color',
      ])
      .where({
        and: [
          { isCompleted: { eq: false } },
          {
            or: [
              { priority: { eq: 'high' } },
              { title: { contains: 'urgent' } },
              { dueDate: { gte: new Date('2024-01-01T00:00:00.000Z') } },
            ],
          },
        ],
      })
      .orderBy({
        createdAt: 'desc',
        title: 'asc',
        priority: 'desc',
      })
      .first(25)
      .after('cursor_abc123')
      .buildQueryString();

    // Expected DAB-compliant GraphQL query
    const expectedQuery = `
      query {
        todos(filter: { and: [{ isCompleted: { eq: false } }, { or: [{ priority: { eq: "high" } }, { title: { contains: "urgent" } }, { dueDate: { gte: "2024-01-01T00:00:00.000Z" } }] }] }, orderBy: { createdAt: DESC, title: ASC, priority: DESC }, first: 25, after: "cursor_abc123") {
          items {
            id
            title
            description
            isCompleted
            priority
            dueDate
            category {
              name
              color
            }
          }
        }
      }
    `.trim();

    // Assert - Use compareQueries for detailed diff on failure
    compareQueries(actualQuery, expectedQuery);

    // Validate DAB compliance
    validateDABCompliance(actualQuery);

    // Additional specific assertions
    expect(actualQuery).toContain('todos('); // lowercase plural entity name
    expect(actualQuery).toContain('isCompleted: { eq: false }');
    expect(actualQuery).toContain('priority: { eq: "high" }'); // string values properly quoted
    expect(actualQuery).toContain('createdAt: DESC'); // enum values without quotes
    expect(actualQuery).toContain('title: ASC'); // enum values without quotes
    expect(actualQuery).toContain('first: 25'); // pagination parameter
    expect(actualQuery).toContain('after: "cursor_abc123"'); // cursor as quoted string
    expect(actualQuery).toContain('category {');
    expect(actualQuery).toContain('name');
    expect(actualQuery).toContain('color');
    expect(actualQuery).toContain('and: ['); // logical operators
    expect(actualQuery).toContain('or: ['); // logical operators
    expect(actualQuery).not.toContain('Todos('); // should not be capitalized
    expect(actualQuery).not.toContain('todo('); // should not be singular
  });

  it('should generate correct query with pagination fields', () => {
    // Arrange
    const mockGraphQLClient: GraphQLClient = {
      query: vi.fn(),
      mutation: vi.fn(),
      request: vi.fn(),
    } as any;

    const builder = new TestableGraphQLQueryBuilder<TestSchema, 'Todo'>(
      mockGraphQLClient,
      'Todo'
    );

    // Act - Build query with pagination
    const actualQuery = builder
      .select(['id', 'title'])
      .first(10)
      .buildQueryStringWithPagination();

    // Expected query with pagination fields (DAB style - no nested pageInfo)
    const expectedQuery = `
      query {
        todos(first: 10) {
          items {
            id
            title
          }
          endCursor
          hasNextPage
        }
      }
    `.trim();

    // Assert
    compareQueries(actualQuery, expectedQuery);
    validateDABCompliance(actualQuery);

    // Pagination-specific assertions (DAB only supports forward pagination)
    expect(actualQuery).toContain('hasNextPage');
    expect(actualQuery).toContain('endCursor');
    expect(actualQuery).not.toContain('pageInfo'); // DAB doesn't nest these in pageInfo
    expect(actualQuery).not.toContain('hasPreviousPage'); // DAB doesn't support backward pagination
    expect(actualQuery).not.toContain('startCursor'); // DAB doesn't support startCursor
  });

  describe('String Filter Operators', () => {
    const cases = [
      {
        op: 'neq',
        filter: { title: { neq: 'archived' } },
        expected: 'title: { neq: "archived" }',
      },
      {
        op: 'gt',
        filter: { title: { gt: 'a' } },
        expected: 'title: { gt: "a" }',
      },
      {
        op: 'gte',
        filter: { title: { gte: 'm' } },
        expected: 'title: { gte: "m" }',
      },
      {
        op: 'lt',
        filter: { title: { lt: 'z' } },
        expected: 'title: { lt: "z" }',
      },
      {
        op: 'lte',
        filter: { title: { lte: 'n' } },
        expected: 'title: { lte: "n" }',
      },
      {
        op: 'notContains',
        filter: { title: { notContains: 'deprecated' } },
        expected: 'title: { notContains: "deprecated" }',
      },
      {
        op: 'startsWith',
        filter: { title: { startsWith: 'feat' } },
        expected: 'title: { startsWith: "feat" }',
      },
      {
        op: 'endsWith',
        filter: { title: { endsWith: 'beta' } },
        expected: 'title: { endsWith: "beta" }',
      },
      {
        op: 'in',
        filter: { title: { in: ['foo', 'bar'] } },
        expected: 'title: { in: ["foo", "bar"] }',
      },
      {
        op: 'isNull',
        filter: { title: { isNull: true } },
        expected: 'title: { isNull: true }',
      },
    ] as const;

    for (const testCase of cases) {
      it(`supports ${testCase.op}`, () => {
        const builder = createBuilder();
        const actualQuery = builder
          .where(testCase.filter as any)
          .buildQueryString();

        const expectedQuery = `
          query {
            todos(filter: { ${testCase.expected} }) {
              items {
                id
              }
            }
          }
        `.trim();

        compareQueries(actualQuery, expectedQuery);
        validateDABCompliance(actualQuery);
        expect(actualQuery).toContain(testCase.expected);
      });
    }
  });

  describe('Number Filter Operators', () => {
    const cases = [
      {
        op: 'eq',
        filter: { priorityLevel: { eq: 1 } },
        expected: 'priorityLevel: { eq: 1 }',
      },
      {
        op: 'neq',
        filter: { priorityLevel: { neq: 0 } },
        expected: 'priorityLevel: { neq: 0 }',
      },
      {
        op: 'gt',
        filter: { priorityLevel: { gt: 2 } },
        expected: 'priorityLevel: { gt: 2 }',
      },
      {
        op: 'gte',
        filter: { priorityLevel: { gte: 3 } },
        expected: 'priorityLevel: { gte: 3 }',
      },
      {
        op: 'lt',
        filter: { priorityLevel: { lt: 5 } },
        expected: 'priorityLevel: { lt: 5 }',
      },
      {
        op: 'lte',
        filter: { priorityLevel: { lte: 4 } },
        expected: 'priorityLevel: { lte: 4 }',
      },
      {
        op: 'in',
        filter: { priorityLevel: { in: [1, 2, 3] } },
        expected: 'priorityLevel: { in: [1, 2, 3] }',
      },
      {
        op: 'isNull',
        filter: { priorityLevel: { isNull: true } },
        expected: 'priorityLevel: { isNull: true }',
      },
    ] as const;

    for (const testCase of cases) {
      it(`supports ${testCase.op}`, () => {
        const builder = createBuilder();
        const actualQuery = builder
          .where(testCase.filter as any)
          .buildQueryString();

        const expectedQuery = `
          query {
            todos(filter: { ${testCase.expected} }) {
              items {
                id
              }
            }
          }
        `.trim();

        compareQueries(actualQuery, expectedQuery);
        validateDABCompliance(actualQuery);
        expect(actualQuery).toContain(testCase.expected);
      });
    }
  });

  describe('Boolean Filter Operators', () => {
    const cases = [
      {
        op: 'neq',
        filter: { isCompleted: { neq: true } },
        expected: 'isCompleted: { neq: true }',
      },
      {
        op: 'in',
        filter: { isCompleted: { in: [true, false] } },
        expected: 'isCompleted: { in: [true, false] }',
      },
      {
        op: 'isNull',
        filter: { isCompleted: { isNull: false } },
        expected: 'isCompleted: { isNull: false }',
      },
    ] as const;

    for (const testCase of cases) {
      it(`supports ${testCase.op}`, () => {
        const builder = createBuilder();
        const actualQuery = builder
          .where(testCase.filter as any)
          .buildQueryString();

        const expectedQuery = `
          query {
            todos(filter: { ${testCase.expected} }) {
              items {
                id
              }
            }
          }
        `.trim();

        compareQueries(actualQuery, expectedQuery);
        validateDABCompliance(actualQuery);
        expect(actualQuery).toContain(testCase.expected);
      });
    }
  });

  describe('Date Filter Operators', () => {
    const date1 = new Date('2024-01-02T00:00:00.000Z');
    const date2 = new Date('2024-02-01T00:00:00.000Z');
    const cases = [
      {
        op: 'eq',
        filter: { dueDate: { eq: date1 } },
        expected: `dueDate: { eq: "${date1.toISOString()}" }`,
      },
      {
        op: 'neq',
        filter: { dueDate: { neq: date1 } },
        expected: `dueDate: { neq: "${date1.toISOString()}" }`,
      },
      {
        op: 'gt',
        filter: { dueDate: { gt: date1 } },
        expected: `dueDate: { gt: "${date1.toISOString()}" }`,
      },
      {
        op: 'gte',
        filter: { dueDate: { gte: date1 } },
        expected: `dueDate: { gte: "${date1.toISOString()}" }`,
      },
      {
        op: 'lt',
        filter: { dueDate: { lt: date2 } },
        expected: `dueDate: { lt: "${date2.toISOString()}" }`,
      },
      {
        op: 'lte',
        filter: { dueDate: { lte: date2 } },
        expected: `dueDate: { lte: "${date2.toISOString()}" }`,
      },
      {
        op: 'in',
        filter: { dueDate: { in: [date1, date2] } },
        expected: `dueDate: { in: ["${date1.toISOString()}", "${date2.toISOString()}"] }`,
      },
      {
        op: 'isNull',
        filter: { dueDate: { isNull: true } },
        expected: 'dueDate: { isNull: true }',
      },
    ] as const;

    for (const testCase of cases) {
      it(`supports ${testCase.op}`, () => {
        const builder = createBuilder();
        const actualQuery = builder
          .where(testCase.filter as any)
          .buildQueryString();

        const expectedQuery = `
          query {
            todos(filter: { ${testCase.expected} }) {
              items {
                id
              }
            }
          }
        `.trim();

        compareQueries(actualQuery, expectedQuery);
        validateDABCompliance(actualQuery);
        expect(actualQuery).toContain(testCase.expected);
      });
    }
  });

  describe('Logical Operators', () => {
    it('supports not operator', () => {
      const builder = createBuilder();
      const actualQuery = builder
        .where({ not: { title: { eq: 'secret' } } } as any)
        .buildQueryString();

      const expectedQuery = `
        query {
          todos(filter: { not: { title: { eq: "secret" } } }) {
            items {
              id
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
    });

    it('supports nested logical operators (and/or/not)', () => {
      const builder = createBuilder();
      const actualQuery = builder
        .where({
          or: [
            {
              and: [
                { title: { contains: 'urgent' } },
                { isCompleted: { eq: false } },
              ],
            },
            { not: { priorityLevel: { lt: 2 } } },
          ],
        } as any)
        .buildQueryString();

      const expectedQuery = `
        query {
          todos(filter: { or: [{ and: [{ title: { contains: "urgent" } }, { isCompleted: { eq: false } }] }, { not: { priorityLevel: { lt: 2 } } }] }) {
            items {
              id
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
      expect(actualQuery).toContain('or: [');
      expect(actualQuery).toContain('and: [');
      expect(actualQuery).toContain('not: {');
    });
  });

  describe('Empty/Minimal Queries', () => {
    it('defaults to selecting id when no fields or filters provided', () => {
      const builder = createBuilder();
      const actualQuery = builder.first(1).buildQueryString();

      const expectedQuery = `
        query {
          todos(first: 1) {
            items {
              id
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
      expect(actualQuery).toContain('id');
    });
  });

  describe('Deep Nested Field Selection', () => {
    it('should handle 2-level nested field selection (category.name)', () => {
      const builder = createBuilder();
      const actualQuery = builder
        .select(['id', 'title', 'category.name'] as any)
        .buildQueryString();

      const expectedQuery = `
        query {
          todos {
            items {
              id
              title
              category {
                name
              }
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
      expect(actualQuery).toContain('category {');
      expect(actualQuery).toContain('name');
    });

    // TODO: 3+ level nesting is not yet supported by GraphQLQueryBuilder.
    // The current implementation only handles 2-level paths (e.g., 'category.name').
    // Deeper paths like 'category.user.email' are truncated to 'category.user'.
    // See GraphQLQueryBuilder.buildFieldSelection() which uses split('.', 2).
    it.skip('should handle 3-level nested field selection (category.user.email)', () => {
      const builder = createBuilder();
      const actualQuery = builder
        .select(['id', 'category.user.email'] as any)
        .buildQueryString();

      // Expected: proper 3-level nesting in GraphQL
      const expectedQuery = `
        query {
          todos {
            items {
              id
              category {
                user {
                  email
                }
              }
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
      expect(actualQuery).toContain('category {');
      expect(actualQuery).toContain('user {');
      expect(actualQuery).toContain('email');
    });

    // TODO: 4-level nesting (user.profile.address.city) is not yet supported.
    // Requires recursive field selection building in GraphQLQueryBuilder.
    it.skip('should handle 4-level nested field selection (user.profile.address.city)', () => {
      const mockGraphQLClient = {
        query: vi.fn(),
        mutation: vi.fn(),
        request: vi.fn(),
      } as any;

      const builder = new TestableGraphQLQueryBuilder<TestSchema, 'User'>(
        mockGraphQLClient,
        'User'
      );

      const actualQuery = builder
        .select(['id', 'email', 'profile.address.city'] as any)
        .buildQueryString();

      // Expected: proper 4-level nesting in GraphQL
      const expectedQuery = `
        query {
          users {
            items {
              id
              email
              profile {
                address {
                  city
                }
              }
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
      expect(actualQuery).toContain('profile {');
      expect(actualQuery).toContain('address {');
      expect(actualQuery).toContain('city');
    });

    it('should handle multiple nested fields at same level', () => {
      const builder = createBuilder();
      const actualQuery = builder
        .select(['id', 'category.name', 'category.color', 'user.email'] as any)
        .buildQueryString();

      const expectedQuery = `
        query {
          todos {
            items {
              id
              category {
                name
                color
              }
              user {
                email
              }
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
      expect(actualQuery).toContain('category {');
      expect(actualQuery).toContain('user {');
    });

    it('should handle mixed scalar and nested fields', () => {
      const builder = createBuilder();
      const actualQuery = builder
        .select([
          'id',
          'title',
          'description',
          'isCompleted',
          'category.name',
        ] as any)
        .buildQueryString();

      const expectedQuery = `
        query {
          todos {
            items {
              id
              title
              description
              isCompleted
              category {
                name
              }
            }
          }
        }
      `.trim();

      compareQueries(actualQuery, expectedQuery);
      validateDABCompliance(actualQuery);
    });

    it('should deduplicate overlapping nested field selections', () => {
      const builder = createBuilder();
      // Selecting both 'category' and 'category.name' should not duplicate
      const actualQuery = builder
        .select(['id', 'category.name', 'category.color'] as any)
        .buildQueryString();

      // Should produce a single category block with both fields
      expect(actualQuery).toContain('category {');
      // Count occurrences of 'category {'
      const categoryCount = (actualQuery.match(/category\s*\{/g) || []).length;
      expect(categoryCount).toBe(1);
      expect(actualQuery).toContain('name');
      expect(actualQuery).toContain('color');
    });
  });
});
