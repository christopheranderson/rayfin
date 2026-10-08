import type { ApiClient } from '@microsoft/rayfin-lib';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  AggregationEntry,
  AggregationResult,
  AggregationSpec,
  GroupedAggregationRow,
  NumericKeys,
  ScalarKeys,
} from '../../graphql/aggregation-types';
import { createDataApi } from '../../index';

// A representative entity type. Not tied to the runtime test schema; the
// point of this file is to exercise the aggregation types themselves.
interface Order {
  id: string;
  region: string;
  status: 'shipped' | 'pending';
  amount: number;
  tax: number;
  createdAt: Date;
  isRefunded: boolean;
  customer: { id: string; name: string }; // relationship (object)
  lines: { id: string; qty: number }[]; // relationship (array)
}

describe('aggregation type-level positive tests', () => {
  it('NumericKeys<Order> resolves to numeric scalar keys only', () => {
    expectTypeOf<NumericKeys<Order>>().toEqualTypeOf<'amount' | 'tax'>();
  });

  it('ScalarKeys<Order> excludes relationships and arrays', () => {
    expectTypeOf<ScalarKeys<Order>>().toEqualTypeOf<
      'id' | 'region' | 'status' | 'amount' | 'tax' | 'createdAt' | 'isRefunded'
    >();
  });

  it('AggregationResult distinguishes count from numeric ops', () => {
    expectTypeOf<AggregationResult<{ count: 'id' }>>().toEqualTypeOf<number>();
    expectTypeOf<AggregationResult<{ sum: 'amount' }>>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<AggregationResult<{ avg: 'amount' }>>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<AggregationResult<{ min: 'amount' }>>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<AggregationResult<{ max: 'amount' }>>().toEqualTypeOf<
      number | null
    >();
  });

  it('accepts a valid aggregation specification (shorthand and options)', () => {
    const spec = {
      revenue: { sum: 'amount' },
      taxTotal: { sum: 'tax' },
      biggest: { max: { field: 'amount', having: { gt: 500 } } },
      orders: { count: 'amount' },
      distinctAmounts: { count: { field: 'amount', distinct: true } },
    } as const satisfies AggregationSpec<Order>;

    // Row result type: fields is Pick<Order, group[number]>, aggregations
    // mirrors alias -> AggregationResult<entry>.
    type Row = GroupedAggregationRow<Order, readonly ['region'], typeof spec>;
    expectTypeOf<Row['fields']>().toEqualTypeOf<Pick<Order, 'region'>>();
    expectTypeOf<Row['aggregations']['revenue']>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<Row['aggregations']['orders']>().toEqualTypeOf<number>();
    expectTypeOf<
      Row['aggregations']['distinctAmounts']
    >().toEqualTypeOf<number>();
    expectTypeOf<Row['aggregations']['biggest']>().toEqualTypeOf<
      number | null
    >();
  });

  it('AggregationEntry rejects two ops in one entry (compile-time)', () => {
    // A fresh literal with two op keys is not assignable to AggregationEntry.
    // We assert that by checking the assignment fails via a helper.
    type OnlySum = { sum: 'amount' };
    type WithTwoOps = { sum: 'amount'; avg: 'amount' };

    expectTypeOf<OnlySum>().toMatchTypeOf<AggregationEntry<Order>>();
    // WithTwoOps must NOT be assignable to AggregationEntry<Order>.
    expectTypeOf<WithTwoOps>().not.toMatchTypeOf<AggregationEntry<Order>>();
  });

  it('groupBy(...).aggregate(...) narrows row `fields` to exactly the grouped keys', () => {
    interface Sale {
      id: string;
      region: string;
      status: 'shipped' | 'pending';
      amount: number;
    }

    const client = createDataApi<{ Sale: Sale }>({} as ApiClient);

    // Single group key: fields is Pick<Sale, 'region'>, not every scalar.
    const singleRows = client.Sale.groupBy(['region']).aggregate({
      revenue: { sum: 'amount' },
    });
    type SingleRow = Awaited<ReturnType<typeof singleRows.execute>>[number];
    expectTypeOf<SingleRow['fields']>().toEqualTypeOf<Pick<Sale, 'region'>>();
    expectTypeOf<SingleRow['aggregations']['revenue']>().toEqualTypeOf<
      number | null
    >();

    // Multiple group keys: fields is Pick<Sale, 'region' | 'status'>.
    const multiRows = client.Sale.groupBy(['region', 'status']).aggregate({
      n: { count: 'amount' },
    });
    type MultiRow = Awaited<ReturnType<typeof multiRows.execute>>[number];
    expectTypeOf<MultiRow['fields']>().toEqualTypeOf<
      Pick<Sale, 'region' | 'status'>
    >();

    // The grouped stage carries the keys through where() as well.
    const filteredRows = client.Sale.groupBy(['region'])
      .where({ status: { eq: 'shipped' } })
      .aggregate({ revenue: { sum: 'amount' } });
    type FilteredRow = Awaited<ReturnType<typeof filteredRows.execute>>[number];
    expectTypeOf<FilteredRow['fields']>().toEqualTypeOf<Pick<Sale, 'region'>>();
  });

  it('the initial where() still reaches groupBy()/aggregate() and the row surface still executes to rows', () => {
    interface Sale {
      id: string;
      region: string;
      status: 'shipped' | 'pending';
      amount: number;
    }

    const client = createDataApi<{ Sale: Sale }>({} as ApiClient);

    // A leading where() (before any row method) stays aggregation-capable, so
    // where().groupBy().aggregate() and where().aggregate() still compile.
    const grouped = client.Sale.where({ status: { eq: 'shipped' } })
      .groupBy(['region'])
      .aggregate({ revenue: { sum: 'amount' } });
    type GroupedRow = Awaited<ReturnType<typeof grouped.execute>>[number];
    expectTypeOf<GroupedRow['fields']>().toEqualTypeOf<Pick<Sale, 'region'>>();

    const grandTotal = client.Sale.where({
      status: { eq: 'shipped' },
    }).aggregate({ revenue: { sum: 'amount' } });
    type GrandTotalRow = Awaited<ReturnType<typeof grandTotal.execute>>[number];
    // Grand-total (no groupBy) carries no grouped keys, so `fields` is `{}`,
    // not the broad scalar set — `row.fields.amount` must not type-check.
    expectTypeOf<GrandTotalRow['fields']>().toEqualTypeOf<{}>();
    expectTypeOf<GrandTotalRow['aggregations']['revenue']>().toEqualTypeOf<
      number | null
    >();

    // The row surface (select().where().orderBy().first()) still resolves to
    // plain entity rows via execute().
    const rows = client.Sale.select(['id', 'region'])
      .where({ status: { eq: 'shipped' } })
      .orderBy({ amount: 'desc' })
      .first(10);
    expectTypeOf<Awaited<ReturnType<typeof rows.execute>>>().toEqualTypeOf<
      Sale[]
    >();
  });
});
