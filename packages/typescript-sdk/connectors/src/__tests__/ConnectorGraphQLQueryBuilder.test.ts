import { entity, many, one } from '@microsoft/rayfin-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ConnectorGraphQLQueryBuilder } from '../category-a/ConnectorGraphQLQueryBuilder';
import { Source } from '../category-a/schema/source';

// A three-level relationship model: Sensor → readings[] → alerts[] → alertId.
@entity()
class Alert extends Source({ table: 'Alert', primaryKey: ['alertId'] }) {
  alertId!: string;
  message!: string;
}

@entity()
class Reading extends Source({ table: 'Reading', primaryKey: ['id'] }) {
  id!: string;
  value!: number;

  @many(() => Alert, { sourceFields: ['id'], targetFields: ['alertId'] })
  alerts!: Alert[];
}

@entity()
class Sensor extends Source({ table: 'Sensor', primaryKey: ['id'] }) {
  id!: string;
  name!: string;

  @many(() => Reading, { sourceFields: ['id'], targetFields: ['id'] })
  readings!: Reading[];
}

type TestSchema = {
  Sensor: Sensor;
  Reading: Reading;
  Alert: Alert;
};

// A model whose field names deliberately disagree with their decorator
// cardinality, so the `items` wrapper can only be correct if it comes from the
// metadata (`@one`/`@many`) and not from the field name. The removed
// `isPlural(field)` heuristic would shape both of these the wrong way.
@entity()
class Wheel extends Source({ table: 'Wheel', primaryKey: ['id'] }) {
  id!: string;
}

@entity()
class Engine extends Source({ table: 'Engine', primaryKey: ['id'] }) {
  id!: string;

  // A to-many nested under a to-one — exercises childMeta threading through the
  // @one branch of renderSelectionTree.
  @many(() => Wheel, { sourceFields: ['id'], targetFields: ['id'] })
  parts!: Wheel[];
}

@entity()
class Car extends Source({ table: 'Car', primaryKey: ['id'] }) {
  id!: string;

  // Singular field name, but a to-many relationship.
  @many(() => Wheel, { sourceFields: ['id'], targetFields: ['id'] })
  wheel!: Wheel[];

  // Plural field name, but a to-one relationship.
  @one(() => Engine, { sourceFields: ['id'], targetFields: ['id'] })
  settings!: Engine;
}

type CarSchema = {
  Car: Car;
  Wheel: Wheel;
  Engine: Engine;
};

describe('ConnectorGraphQLQueryBuilder', () => {
  let mockGraphQLClient: any;
  let builder: ConnectorGraphQLQueryBuilder<TestSchema, 'Sensor'>;

  beforeEach(() => {
    mockGraphQLClient = {
      query: vi.fn(),
      mutation: vi.fn(),
      request: vi.fn(),
    };
    builder = new ConnectorGraphQLQueryBuilder(
      mockGraphQLClient,
      'Sensor',
      Sensor
    );
  });

  it('wraps every nested plural relationship in its own items connection', async () => {
    mockGraphQLClient.query.mockResolvedValue({
      data: { sensors: { items: [] } },
    });

    await builder
      .select(['id', 'readings.value', 'readings.alerts.alertId'])
      .execute();

    const query: string = mockGraphQLClient.query.mock.calls[0][0];
    // Root connection + two nested plural relationships → three `items` wrappers.
    expect(query.match(/items \{/g)?.length).toBe(3);
    // The deep leaf is preserved at full path depth.
    expect(query).toContain('alertId');
    // Nested plural is emitted as a selection set, not a scalar leaf.
    expect(query).toMatch(/alerts \{[\s\S]*items \{[\s\S]*alertId/);
  });

  it('recursively unwraps nested items connections on read', async () => {
    mockGraphQLClient.query.mockResolvedValue({
      data: {
        sensors: {
          items: [
            {
              id: 's1',
              readings: {
                items: [
                  {
                    value: 42,
                    alerts: { items: [{ alertId: 'a1' }] },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const [sensor] = await builder
      .select(['id', 'readings.value', 'readings.alerts.alertId'])
      .execute();

    // Each connection wrapper is flattened to a plain array at every depth.
    expect(Array.isArray(sensor.readings)).toBe(true);
    expect(Array.isArray(sensor.readings[0].alerts)).toBe(true);
    expect(sensor.readings[0].alerts[0].alertId).toBe('a1');
  });

  it('leaves a null relationship chain in place without unwrapping', async () => {
    mockGraphQLClient.query.mockResolvedValue({
      data: {
        sensors: {
          items: [{ id: 's1', readings: null }],
        },
      },
    });

    const [sensor] = await builder
      .select(['id', 'readings.value', 'readings.alerts.alertId'])
      .execute();

    expect(sensor.readings).toBeNull();
  });

  it('throws when no fields are selected (connectors have no default id)', async () => {
    await expect(builder.execute()).rejects.toThrow(/explicit \.select/);
    // The query must never be sent when the selection is empty.
    expect(mockGraphQLClient.query).not.toHaveBeenCalled();
  });

  it('shapes the items wrapper from decorator cardinality, not the field name', async () => {
    const carBuilder = new ConnectorGraphQLQueryBuilder<CarSchema, 'Car'>(
      mockGraphQLClient,
      'Car',
      Car
    );
    mockGraphQLClient.query.mockResolvedValue({
      data: { cars: { items: [] } },
    });

    await carBuilder.select(['id', 'wheel.id', 'settings.id']).execute();

    const query: string = mockGraphQLClient.query.mock.calls[0][0];
    // Root connection + the one to-many (`wheel`) → two `items` wrappers. The
    // to-one (`settings`) adds none, despite its plural-looking name.
    expect(query.match(/items \{/g)?.length).toBe(2);
    // Singular name but @many → wrapped in its own items connection.
    expect(query).toMatch(/wheel \{[\s\S]*items \{[\s\S]*id/);
    // Plural name but @one → nested directly, with no items wrapper.
    const settingsBlock = query.slice(query.indexOf('settings {'));
    expect(settingsBlock).not.toContain('items');
  });

  it('threads metadata through a to-one into a nested to-many', async () => {
    const carBuilder = new ConnectorGraphQLQueryBuilder<CarSchema, 'Car'>(
      mockGraphQLClient,
      'Car',
      Car
    );
    mockGraphQLClient.query.mockResolvedValue({
      data: { cars: { items: [] } },
    });

    // settings (@one) → parts (@many). If childMeta did not advance through the
    // to-one branch, `parts` could not be resolved as a relationship at all.
    await carBuilder.select(['id', 'settings.parts.id']).execute();

    const query: string = mockGraphQLClient.query.mock.calls[0][0];
    const settingsBlock = query.slice(query.indexOf('settings {'));
    // The to-one adds no items wrapper of its own...
    expect(query.match(/items \{/g)?.length).toBe(2);
    // ...but the nested to-many under it does.
    expect(settingsBlock).toMatch(/parts \{[\s\S]*items \{[\s\S]*id/);
  });

  it('throws when selecting a relationship with no registered entities (no metadata)', async () => {
    // No entity class passed → no metadata → cardinality unknown.
    const noMeta = new ConnectorGraphQLQueryBuilder<TestSchema, 'Sensor'>(
      mockGraphQLClient,
      'Sensor'
    );

    await expect(
      noMeta.select(['id', 'readings.value']).execute()
    ).rejects.toMatchObject({
      code: 'ENTITIES_REQUIRED_FOR_RELATIONSHIP_SELECT',
    });
    // The malformed query must never be sent.
    expect(mockGraphQLClient.query).not.toHaveBeenCalled();
  });

  it('allows a scalar-only select with no registered entities (no metadata)', async () => {
    const noMeta = new ConnectorGraphQLQueryBuilder<TestSchema, 'Sensor'>(
      mockGraphQLClient,
      'Sensor'
    );
    mockGraphQLClient.query.mockResolvedValue({
      data: { sensors: { items: [] } },
    });

    // A scalar-only select needs no cardinality metadata, so it must succeed.
    await noMeta.select(['id', 'name']).execute();

    const query: string = mockGraphQLClient.query.mock.calls[0][0];
    expect(query).toContain('id');
    expect(query).toContain('name');
    expect(query).not.toMatch(/readings|alerts/);
  });

  it('throws INVALID_RELATIONSHIP_SELECTION when a selected field with children is not a relationship', async () => {
    // `name` is a scalar on Sensor; a nested path under it makes it a
    // relationship node in the tree, but the metadata says it is not one. The
    // typed `select` rejects this, so the cast reproduces the untyped / wrong-
    // entities-class case this runtime guard backstops.
    await expect(
      builder.select(['id', 'name.value'] as never).execute()
    ).rejects.toMatchObject({ code: 'INVALID_RELATIONSHIP_SELECTION' });
    expect(mockGraphQLClient.query).not.toHaveBeenCalled();
  });
});

describe('ConnectorGraphQLQueryBuilder aggregation', () => {
  const mockGraphQLClient = {
    query: vi.fn(),
    mutation: vi.fn(),
    request: vi.fn(),
  } as any;

  const readings = () =>
    new ConnectorGraphQLQueryBuilder<TestSchema, 'Reading'>(
      mockGraphQLClient,
      'Reading'
    );

  it('generates a DAB-compliant groupBy + aggregate query', () => {
    const query = readings()
      .groupBy(['id'])
      .aggregate({ total: { sum: 'value' } })
      .buildQueryString();

    expect(query).toContain('readings {');
    expect(query).toContain('groupBy(fields: [id])');
    expect(query).toMatch(/fields \{[\s\S]*id[\s\S]*\}/);
    expect(query).toContain('total: sum(field: value)');
    // groupBy aggregation must never emit a row `items` connection.
    expect(query).not.toContain('items {');
  });

  it('carries a preceding where() filter into the aggregation query', () => {
    const query = readings()
      .where({ value: { gt: 10 } })
      .groupBy(['id'])
      .aggregate({ total: { sum: 'value' } })
      .buildQueryString();

    expect(query).toContain('readings(filter: { value: { gt: 10 } })');
    expect(query).toContain('groupBy(fields: [id])');
    expect(query).toContain('total: sum(field: value)');
  });

  it('emits a grand-total aggregation with no grouping fields', () => {
    const query = readings()
      .aggregate({
        total: { sum: 'value' },
        n: { count: 'value' },
      })
      .buildQueryString();

    expect(query).toContain('total: sum(field: value)');
    expect(query).toContain('n: count(field: value)');
    expect(query).not.toContain('items {');
  });

  it('emits having and distinct options on the connector path', () => {
    const query = readings()
      .groupBy(['id'])
      .aggregate({
        big: { max: { field: 'value', having: { gt: 500 } } },
        uniques: { count: { field: 'value', distinct: true } },
      })
      .buildQueryString();

    expect(query).toContain('big: max(field: value, having: { gt: 500 })');
    expect(query).toContain('uniques: count(field: value, distinct: true)');
  });
});
