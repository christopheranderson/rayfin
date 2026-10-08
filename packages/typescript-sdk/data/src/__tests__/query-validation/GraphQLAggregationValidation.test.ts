import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

import { createDataApi } from '../../index';

import { compareQueries } from './query-utils';
import type { TestSchema } from './sample-models';

// GA-rollout gate: some assertions in this file exercise the new
// no-string-coercion behavior; enable the flag.
let _originalFlags: string | undefined;
beforeAll(() => {
  _originalFlags = process.env.RAYFIN_FEATURE_FLAGS;
  process.env.RAYFIN_FEATURE_FLAGS = 'cli-minor-fixes';
});
afterAll(() => {
  if (_originalFlags === undefined) delete process.env.RAYFIN_FEATURE_FLAGS;
  else process.env.RAYFIN_FEATURE_FLAGS = _originalFlags;
});

const makeClient = () => {
  const post = vi.fn();
  const apiClient = { post } as any;
  const dataApi = createDataApi<TestSchema>(apiClient);
  return { dataApi, post };
};

describe('GraphQL Aggregation Query Validation', () => {
  it('generates a DAB-compliant groupBy + single aggregate query', () => {
    const { dataApi } = makeClient();

    const agg = dataApi.Todo.where({ isCompleted: { eq: false } })
      .groupBy(['priority'])
      .aggregate({ total: { sum: 'priorityLevel' } });

    const expected = `
      query {
        todos(filter: { isCompleted: { eq: false } }) {
          groupBy(fields: [priority]) {
            fields {
              priority
            }
            aggregations {
              total: sum(field: priorityLevel)
            }
          }
        }
      }
    `.trim();

    compareQueries(agg.buildQueryString(), expected);
  });

  it('emits multiple aggregations of the SAME op with different aliases', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority'])
      .aggregate({
        totalLevel: { sum: 'priorityLevel' },
        maxLevel: { sum: 'priorityLevel' },
      })
      .buildQueryString();

    expect(actual).toContain('totalLevel: sum(field: priorityLevel)');
    expect(actual).toContain('maxLevel: sum(field: priorityLevel)');
    // Only one aggregations block per query
    expect(actual.match(/aggregations \{/g)?.length ?? 0).toBe(1);
  });

  it('emits the having filter on an aggregation', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority'])
      .aggregate({
        big: { max: { field: 'priorityLevel', having: { gt: 500 } } },
      })
      .buildQueryString();

    expect(actual).toContain(
      'big: max(field: priorityLevel, having: { gt: 500 })'
    );
  });

  it('emits distinct on an aggregation', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority'])
      .aggregate({ n: { count: { field: 'priorityLevel', distinct: true } } })
      .buildQueryString();

    expect(actual).toContain('n: count(field: priorityLevel, distinct: true)');
  });

  it('never emits items, endCursor, or hasNextPage in an aggregation query', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority'])
      .aggregate({ revenue: { sum: 'priorityLevel' } })
      .buildQueryString();

    expect(actual).not.toMatch(/\bitems\b/);
    expect(actual).not.toMatch(/\bendCursor\b/);
    expect(actual).not.toMatch(/\bhasNextPage\b/);
    expect(actual).toMatch(/\bgroupBy\b/);
  });

  it('emits field tokens UNQUOTED in groupBy and every aggregation', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority', 'type'])
      .aggregate({
        total: { sum: 'priorityLevel' },
        n: { count: 'priorityLevel' },
      })
      .buildQueryString();

    // No quoted enum tokens for field/groupBy positions
    expect(actual).not.toContain('"priority"');
    expect(actual).not.toContain('"type"');
    expect(actual).not.toContain('"priorityLevel"');
    expect(actual).not.toContain('"id"');

    // Unquoted tokens present
    expect(actual).toContain('groupBy(fields: [priority, type])');
    expect(actual).toContain('sum(field: priorityLevel)');
    expect(actual).toContain('count(field: priorityLevel)');
  });

  it('fields sub-selection matches the groupBy argument (and lists each once)', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority', 'type'])
      .aggregate({ total: { sum: 'priorityLevel' } })
      .buildQueryString();

    // fields sub-selection lists each grouped field exactly once
    expect(actual).toMatch(/fields \{\s*priority\s+type\s*\}/);
    expect(actual).toContain('groupBy(fields: [priority, type])');

    // The sub-selection should never include ungrouped columns like priorityLevel
    expect(actual).not.toMatch(/fields \{[^}]*priorityLevel/);
  });

  it('omits the fields sub-selection when no grouping fields are supplied', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.aggregate({
      total: { sum: 'priorityLevel' },
    }).buildQueryString();

    expect(actual).not.toMatch(/groupBy\(/);
    expect(actual).not.toMatch(/fields \{/);
    expect(actual).toContain('total: sum(field: priorityLevel)');
  });

  it('de-dupes groupBy fields at runtime', () => {
    const { dataApi } = makeClient();

    // Cast is intentional: TS would reject the duplicate literal, but we want
    // to exercise the runtime de-dupe path.
    const actual = dataApi.Todo.groupBy(['priority', 'priority'] as any)
      .aggregate({ total: { sum: 'priorityLevel' } })
      .buildQueryString();

    expect(actual).toContain('groupBy(fields: [priority])');
  });

  it('validates each aggregation op emits the expected shape (sum/avg/min/max/count)', () => {
    const { dataApi } = makeClient();

    const actual = dataApi.Todo.groupBy(['priority'])
      .aggregate({
        s: { sum: 'priorityLevel' },
        a: { avg: 'priorityLevel' },
        mn: { min: 'priorityLevel' },
        mx: { max: 'priorityLevel' },
        c: { count: 'priorityLevel' },
      })
      .buildQueryString();

    expect(actual).toContain('s: sum(field: priorityLevel)');
    expect(actual).toContain('a: avg(field: priorityLevel)');
    expect(actual).toContain('mn: min(field: priorityLevel)');
    expect(actual).toContain('mx: max(field: priorityLevel)');
    expect(actual).toContain('c: count(field: priorityLevel)');
  });

  describe('runtime validation', () => {
    it('rejects an empty spec', () => {
      const { dataApi } = makeClient();
      expect(() =>
        dataApi.Todo.groupBy(['priority']).aggregate({} as any)
      ).toThrow(/at least one entry/);
    });

    it('rejects an entry with two operations (both defined)', () => {
      const { dataApi } = makeClient();
      expect(() =>
        dataApi.Todo.groupBy(['priority']).aggregate({
          bogus: { sum: 'priorityLevel', avg: 'priorityLevel' },
        } as any)
      ).toThrow(/exactly one operation/);
    });

    it('rejects an extra op whose value is undefined (still an own key)', () => {
      const { dataApi } = makeClient();
      expect(() =>
        dataApi.Todo.groupBy(['priority']).aggregate({
          bogus: { sum: 'priorityLevel', avg: undefined },
        } as any)
      ).toThrow(/exactly one operation/);
    });

    it('rejects an unknown operation', () => {
      const { dataApi } = makeClient();
      expect(() =>
        dataApi.Todo.groupBy(['priority']).aggregate({
          bogus: { median: 'priorityLevel' },
        } as any)
      ).toThrow(/Unknown aggregation operation/);
    });

    it.each([['bad-alias'], ['__proto__'], ['1nope'], ['']])(
      'rejects invalid alias token %j',
      (badAlias) => {
        const { dataApi } = makeClient();
        expect(() =>
          dataApi.Todo.groupBy(['priority']).aggregate({
            [badAlias]: { sum: 'priorityLevel' },
          } as any)
        ).toThrow(/Invalid aggregation alias/);
      }
    );

    it('rejects an invalid field token in an aggregation', () => {
      const { dataApi } = makeClient();
      expect(() =>
        dataApi.Todo.groupBy(['priority']).aggregate({
          total: { sum: 'bad-field' },
        } as any)
      ).toThrow(/Invalid aggregation field token/);
    });

    it('rejects an invalid groupBy field token', () => {
      const { dataApi } = makeClient();
      expect(() =>
        dataApi.Todo.groupBy(['bad-field'] as any).aggregate({
          total: { sum: 'priorityLevel' },
        })
      ).toThrow(/Invalid groupBy field token/);
    });
  });

  describe('mutual exclusion with row operations (runtime defense-in-depth)', () => {
    // Compile-time enforcement narrows the return type of `.select()`,
    // `.first()`, `.after()`, and `.orderBy()` to omit `groupBy`/`aggregate`.
    // Here we cast through `any` to exercise the runtime guards, which
    // matter for callers that intentionally or accidentally bypass the
    // type system.

    it('rejects aggregate() combined with select() at runtime', () => {
      const { dataApi } = makeClient();
      const builder: any = dataApi.Todo.select(['id']);
      expect(() =>
        builder
          .groupBy(['priority'])
          .aggregate({ n: { count: 'priorityLevel' } })
      ).toThrow(/select/);
    });

    it('rejects aggregate() combined with first() at runtime', () => {
      const { dataApi } = makeClient();
      const builder: any = dataApi.Todo.first(10);
      expect(() =>
        builder
          .groupBy(['priority'])
          .aggregate({ n: { count: 'priorityLevel' } })
      ).toThrow(/first/);
    });

    it('rejects aggregate() combined with after() at runtime', () => {
      const { dataApi } = makeClient();
      const builder: any = dataApi.Todo.first(10).after('c1');
      expect(() =>
        builder
          .groupBy(['priority'])
          .aggregate({ n: { count: 'priorityLevel' } })
      ).toThrow(/first|after/);
    });

    it('rejects aggregate() combined with orderBy() at runtime', () => {
      const { dataApi } = makeClient();
      const builder: any = dataApi.Todo.orderBy({ createdAt: 'desc' });
      expect(() =>
        builder
          .groupBy(['priority'])
          .aggregate({ n: { count: 'priorityLevel' } })
      ).toThrow(/orderBy/);
    });

    it('rejects execute() called after groupBy() at runtime', async () => {
      const { dataApi } = makeClient();
      const grouped: any = dataApi.Todo.groupBy(['priority']);
      await expect(grouped.execute()).rejects.toThrow(/groupBy/);
    });

    it('rejects executePaginated() called after groupBy() at runtime', async () => {
      const { dataApi } = makeClient();
      const grouped: any = dataApi.Todo.groupBy(['priority']);
      await expect(grouped.executePaginated()).rejects.toThrow(/groupBy/);
    });
  });

  describe('grouped-response unwrapping', () => {
    it('unwraps a full { data: { <entity>: { groupBy: [...] } } } response', () => {
      const { dataApi } = makeClient();
      const agg = dataApi.Todo.groupBy(['priority']).aggregate({
        revenue: { sum: 'priorityLevel' },
      });

      const server = {
        data: {
          todos: {
            groupBy: [
              { fields: { priority: 'high' }, aggregations: { revenue: 100 } },
              { fields: { priority: 'low' }, aggregations: { revenue: 5 } },
            ],
          },
        },
      };

      const rows = agg.unwrapResponse(server);
      expect(rows).toEqual([
        { fields: { priority: 'high' }, aggregations: { revenue: 100 } },
        { fields: { priority: 'low' }, aggregations: { revenue: 5 } },
      ]);
    });

    it('unwraps an already-unwrapped { <entity>: { groupBy: [...] } } response', () => {
      const { dataApi } = makeClient();
      const agg = dataApi.Todo.groupBy(['priority']).aggregate({
        n: { count: 'priorityLevel' },
      });

      const server = {
        todos: {
          groupBy: [{ fields: { priority: 'medium' }, aggregations: { n: 3 } }],
        },
      };

      const rows = agg.unwrapResponse(server);
      expect(rows).toEqual([
        { fields: { priority: 'medium' }, aggregations: { n: 3 } },
      ]);
    });

    it('throws when the entity is missing from the response', () => {
      const { dataApi } = makeClient();
      const agg = dataApi.Todo.groupBy(['priority']).aggregate({
        n: { count: 'priorityLevel' },
      });
      expect(() => agg.unwrapResponse({ data: {} })).toThrow(/missing/);
    });

    it('preserves grouped scalar strings verbatim (no date or boolean coercion)', () => {
      const { dataApi } = makeClient();
      const agg = dataApi.Todo.groupBy(['createdAt', 'isCompleted']).aggregate({
        n: { count: 'priorityLevel' },
      });

      // DAB returns dates as ISO strings and booleans as "true"/"false" strings.
      const server = {
        data: {
          todos: {
            groupBy: [
              {
                fields: {
                  createdAt: '2024-01-15T10:30:00Z',
                  isCompleted: 'true',
                },
                aggregations: { n: 4 },
              },
            ],
          },
        },
      };

      const rows = agg.unwrapResponse(server);
      expect(rows).toHaveLength(1);
      // ISO strings must NOT be coerced to Date, and "true"/"false" strings
      // must NOT be coerced to boolean — a `@text()` or
      // `@set('true', 'false')` field is byte-identical to a `@date()` or
      // `@boolean()` field on the wire. Callers convert explicitly.
      expect(rows[0]?.fields.createdAt).toBe('2024-01-15T10:30:00Z');
      expect(rows[0]?.fields.isCompleted).toBe('true');
      // Numeric aggregations are left untouched.
      expect(rows[0]?.aggregations.n).toBe(4);
    });

    it('propagates through execute()', async () => {
      const { dataApi, post } = makeClient();
      post.mockResolvedValue({
        data: {
          todos: {
            groupBy: [
              {
                fields: { priority: 'high' },
                aggregations: { total: 42, n: 7 },
              },
            ],
          },
        },
      });

      const rows = await dataApi.Todo.groupBy(['priority'])
        .aggregate({
          total: { sum: 'priorityLevel' },
          n: { count: 'priorityLevel' },
        })
        .execute();

      expect(rows).toEqual([
        { fields: { priority: 'high' }, aggregations: { total: 42, n: 7 } },
      ]);
      expect(post).toHaveBeenCalledTimes(1);
      const [endpoint, payload] = post.mock.calls[0] as [string, any];
      expect(endpoint).toBe('/graphql');
      const sent = payload.query as string;
      expect(sent).toContain('groupBy(fields: [priority])');
      expect(sent).toContain('total: sum(field: priorityLevel)');
      expect(sent).toContain('n: count(field: priorityLevel)');
      expect(sent).not.toMatch(/\bitems\b/);
    });
  });
});
