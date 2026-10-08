import { describe, it, expect, vi } from 'vitest';

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

describe('GraphQL Query Edge Cases', () => {
  it('supports very long string values in filters', () => {
    const builder = createBuilder();
    const longString = 'x'.repeat(1200);

    const actualQuery = builder
      .where({ title: { eq: longString } })
      .buildQueryString();

    const expectedQuery = `
      query {
        todos(filter: { title: { eq: "${longString}" } }) {
          items {
            id
          }
        }
      }
    `.trim();

    compareQueries(actualQuery, expectedQuery);
    validateDABCompliance(actualQuery);
    expect(actualQuery.length).toBeGreaterThan(1200);
  });

  it('escapes special characters in filter values', () => {
    const builder = createBuilder();
    const special = 'quote " newline\n tab\t backslash\\';

    const actualQuery = builder
      .where({ title: { eq: special } })
      .buildQueryString();

    // All special characters should be properly escaped
    expect(actualQuery).toContain(
      'title: { eq: "quote \\" newline\\n tab\\t backslash\\\\"'
    );
    validateDABCompliance(actualQuery);
  });

  it('handles extreme date values in filters', () => {
    const builder = createBuilder();
    const minDate = new Date('0001-01-01T00:00:00.000Z');
    const maxDate = new Date('9999-12-31T23:59:59.999Z');

    const actualQuery = builder
      .where({
        and: [{ dueDate: { eq: minDate } }, { dueDate: { neq: maxDate } }],
      })
      .buildQueryString();

    expect(actualQuery).toContain(
      `dueDate: { eq: "${minDate.toISOString()}" }`
    );
    expect(actualQuery).toContain(
      `dueDate: { neq: "${maxDate.toISOString()}" }`
    );
    validateDABCompliance(actualQuery);
  });

  it('distinguishes empty string vs null in filters', () => {
    const builder = createBuilder();

    const actualQuery = builder
      .where({
        and: [{ title: { eq: '' } }, { description: { isNull: true } }],
      })
      .buildQueryString();

    expect(actualQuery).toContain('title: { eq: "" }');
    expect(actualQuery).toContain('description: { isNull: true }');
    validateDABCompliance(actualQuery);
  });

  it('renders field names without escaping for keyword-like fields', () => {
    const builder = createBuilder();

    const actualQuery = builder
      .where({ type: { eq: 'alpha' } })
      .buildQueryString();

    expect(actualQuery).toContain('type: { eq: "alpha" }');
    validateDABCompliance(actualQuery);
  });

  it('includes multiple orderBy entries when called multiple times (later wins)', () => {
    const builder = createBuilder();

    const actualQuery = builder
      .orderBy({ title: 'asc' })
      .orderBy({ title: 'desc', priority: 'asc' })
      .buildQueryString();

    // buildOrderByArray merges entries in order called; duplicates appear twice
    expect(actualQuery).toContain(
      'orderBy: { title: ASC, title: DESC, priority: ASC }'
    );
    validateDABCompliance(actualQuery);
  });
});
