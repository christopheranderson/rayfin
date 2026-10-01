import { ConnectorConfigGenerator } from '@microsoft/rayfin-core/analysis';
import { ConnectorSchemaAnalyzer } from '@microsoft/rayfin-core/analysis';
import {
  entity,
  int,
  many,
  one,
  text,
  uuid,
} from '@microsoft/rayfin-core/decorators';
import { describe, it, expect } from 'vitest';

import { Source } from '../category-a/schema/source';

/**
 * End-to-end (analyzer to config generator) coverage for connector foreign keys
 * that reference composite / custom primary keys, and for the "no phantom id"
 * behavior when an entity declares no primary key.
 */
function buildConfig(...classes: Array<new (...args: never[]) => object>) {
  const analyzed = new ConnectorSchemaAnalyzer(
    classes as never,
    'mssql'
  ).analyzeEntities();
  return new ConnectorConfigGenerator('mssql').generateConfig(analyzed);
}

const fkOf = (entityCfg: {
  ['x-schema']?: { constraints: { foreignKeys?: unknown[] } };
}) => entityCfg['x-schema']!.constraints.foreignKeys!;

describe('connector foreign keys -> composite / custom primary keys', () => {
  it('emits a multi-column FK referencing the target composite key', () => {
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['deviceId', 'seq'],
    }) {
      @text()
      deviceId!: string;
      @int()
      seq!: number;
    }
    @entity()
    class Alert extends Source({ table: 'Alerts' }) {
      @uuid()
      id!: string;
      @one(() => Reading)
      reading!: Reading;
    }

    const config = buildConfig(Reading, Alert);

    // The source is schema-qualified; the primary key travels via top-level
    // `keyFields`, not the source object.
    expect(config.entities.Reading.source).toBe('dbo.Readings');

    // The composite key is emitted top-level as `keyFields` for the backend.
    expect(config.entities.Reading.keyFields).toEqual(['deviceId', 'seq']);

    // The FK on Alert spans both key columns, in declared order.
    const [fk] = fkOf(config.entities.Alert);
    expect(fk).toMatchObject({
      columns: ['reading_deviceId', 'reading_seq'],
      referencedTable: 'dbo.Readings',
      referencedColumns: ['deviceId', 'seq'],
    });

    // Both FK-backing columns are synthesized on Alert.
    const alertFields = config.entities.Alert['x-schema']!.fields;
    expect(alertFields).toHaveProperty('reading_deviceId');
    expect(alertFields).toHaveProperty('reading_seq');

    // The relationship join defaults to the composite key too.
    expect(config.entities.Alert.relationships!.reading).toMatchObject({
      'source.fields': ['reading_deviceId', 'reading_seq'],
      'target.fields': ['deviceId', 'seq'],
    });
  });

  it('emits a matching-arity reverse one-to-many for a composite key', () => {
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['deviceId', 'seq'],
    }) {
      @text()
      deviceId!: string;
      @int()
      seq!: number;
      @many(() => Alert)
      alerts?: Alert[];
    }
    @entity()
    class Alert extends Source({ table: 'Alerts' }) {
      @uuid()
      id!: string;
      @one(() => Reading)
      reading!: Reading;
    }

    const config = buildConfig(Reading, Alert);

    // The reverse one-to-many must map the composite source key to the matching
    // composite FK columns on the target — equal arity, not a single column.
    expect(config.entities.Reading.relationships!.alerts).toMatchObject({
      cardinality: 'many',
      'target.entity': 'Alert',
      'source.fields': ['deviceId', 'seq'],
      'target.fields': ['reading_deviceId', 'reading_seq'],
    });
  });

  it('references a custom single-column key by its real column, not id', () => {
    @entity()
    class Product extends Source({ table: 'Products', primaryKey: ['sku'] }) {
      @text()
      sku!: string;
    }
    @entity()
    class LineItem extends Source({ table: 'LineItems' }) {
      @uuid()
      id!: string;
      @one(() => Product)
      product!: Product;
    }

    const config = buildConfig(Product, LineItem);

    const [fk] = fkOf(config.entities.LineItem);
    expect(fk).toMatchObject({
      columns: ['product_sku'],
      referencedTable: 'dbo.Products',
      referencedColumns: ['sku'],
    });
  });

  it('honors explicit sourceFields/targetFields for a composite FK', () => {
    @entity()
    class Order extends Source({
      table: 'Orders',
      primaryKey: ['id', 'lineNumber'],
    }) {
      @uuid()
      id!: string;
      @int()
      lineNumber!: number;
    }
    @entity()
    class OrderLine extends Source({ table: 'OrderLines' }) {
      @uuid()
      id!: string;
      @uuid()
      orderId!: string;
      @int()
      lineId!: number;
      @one(() => Order, {
        sourceFields: ['orderId', 'lineId'],
        targetFields: ['id', 'lineNumber'],
      })
      order!: Order;
    }

    const config = buildConfig(Order, OrderLine);

    const [fk] = fkOf(config.entities.OrderLine);
    expect(fk).toMatchObject({
      columns: ['orderId', 'lineId'],
      referencedTable: 'dbo.Orders',
      referencedColumns: ['id', 'lineNumber'],
    });
  });

  it('resolves a single-column FK against a declared key', () => {
    @entity()
    class Category extends Source({ table: 'Categories', primaryKey: ['id'] }) {
      @uuid()
      id!: string;
    }
    @entity()
    class Todo extends Source({ table: 'Todos' }) {
      @uuid()
      id!: string;
      @one(() => Category)
      category!: Category;
    }

    const config = buildConfig(Category, Todo);

    const [fk] = fkOf(config.entities.Todo);
    expect(fk).toMatchObject({
      columns: ['category_id'],
      referencedTable: 'dbo.Categories',
      referencedColumns: ['id'],
    });
  });
});

describe('connector foreign keys -> relationship shapes', () => {
  it('emits independent foreign keys for a single-column and a composite parent', () => {
    @entity()
    class Author extends Source({
      table: 'Authors',
      primaryKey: ['authorKey'],
    }) {
      @uuid()
      authorKey!: string;
    }
    @entity()
    class Category extends Source({
      table: 'Categories',
      primaryKey: ['tenantId', 'code'],
    }) {
      @uuid()
      tenantId!: string;
      @text()
      code!: string;
    }
    @entity()
    class Book extends Source({ table: 'Books', primaryKey: ['isbn'] }) {
      @text()
      isbn!: string;
      @one(() => Author)
      author!: Author;
      @one(() => Category)
      category!: Category;
    }

    const config = buildConfig(Author, Category, Book);

    const fks = fkOf(config.entities.Book);
    expect(fks).toHaveLength(2);
    expect(fks).toEqual(
      expect.arrayContaining([
        // Single-column custom key.
        expect.objectContaining({
          columns: ['author_authorKey'],
          referencedTable: 'dbo.Authors',
          referencedColumns: ['authorKey'],
        }),
        // Composite key -> two synthesized FK columns, matching arity.
        expect.objectContaining({
          columns: ['category_tenantId', 'category_code'],
          referencedTable: 'dbo.Categories',
          referencedColumns: ['tenantId', 'code'],
        }),
      ])
    );
  });

  it('honors explicit targetFields pointing at a non-primary-key column', () => {
    @entity()
    class Account extends Source({
      table: 'Accounts',
      primaryKey: ['accountKey'],
    }) {
      @uuid()
      accountKey!: string;
      @text()
      email!: string;
    }
    @entity()
    class LoginSession extends Source({
      table: 'Sessions',
      primaryKey: ['sessionKey'],
    }) {
      @uuid()
      sessionKey!: string;
      @text()
      userEmail!: string;
      @one(() => Account, {
        sourceFields: ['userEmail'],
        targetFields: ['email'],
      })
      account!: Account;
    }

    const config = buildConfig(Account, LoginSession);

    // The FK references `email`, an alternate key on the parent, not its PK
    // (`accountKey`).
    const [fk] = fkOf(config.entities.LoginSession);
    expect(fk).toMatchObject({
      columns: ['userEmail'],
      referencedTable: 'dbo.Accounts',
      referencedColumns: ['email'],
    });
    expect(config.entities.LoginSession.relationships!.account).toMatchObject({
      cardinality: 'one',
      'source.fields': ['userEmail'],
      'target.fields': ['email'],
    });
    // No `account_*` column is synthesized when the source column is explicit.
    const fields = config.entities.LoginSession['x-schema']!.fields;
    expect(fields).not.toHaveProperty('account_accountKey');
  });

  it('supports a self-referencing composite foreign key when optional', () => {
    @entity()
    class Employee extends Source({
      table: 'Employees',
      primaryKey: ['orgId', 'empNo'],
    }) {
      @uuid()
      orgId!: string;
      @int()
      empNo!: number;
      // Self-references must be optional: the first row has no parent to point at.
      @one(() => Employee, { optional: true })
      manager?: Employee;
    }

    const config = buildConfig(Employee);

    // The composite self-FK spans both key columns.
    const [fk] = fkOf(config.entities.Employee);
    expect(fk).toMatchObject({
      columns: ['manager_orgId', 'manager_empNo'],
      referencedTable: 'dbo.Employees',
      referencedColumns: ['orgId', 'empNo'],
    });
    const fields = config.entities.Employee['x-schema']!.fields;
    expect(fields).toHaveProperty('manager_orgId');
    expect(fields).toHaveProperty('manager_empNo');
  });

  it('maps explicit composite columns on both sides of a one-to-many', () => {
    @entity()
    class Order extends Source({
      table: 'Orders',
      primaryKey: ['region', 'orderNo'],
    }) {
      @text()
      region!: string;
      @int()
      orderNo!: number;
      @many(() => LineItem, {
        sourceFields: ['region', 'orderNo'],
        targetFields: ['orderRegion', 'orderNo'],
      })
      lines?: LineItem[];
    }
    @entity()
    class LineItem extends Source({
      table: 'LineItems',
      primaryKey: ['lineKey'],
    }) {
      @uuid()
      lineKey!: string;
      @text()
      orderRegion!: string;
      @int()
      orderNo!: number;
      @one(() => Order, {
        sourceFields: ['orderRegion', 'orderNo'],
        targetFields: ['region', 'orderNo'],
      })
      order!: Order;
    }

    const config = buildConfig(Order, LineItem);

    // Child owns the composite FK on its explicit columns, referencing the
    // parent's composite PK.
    const [fk] = fkOf(config.entities.LineItem);
    expect(fk).toMatchObject({
      columns: ['orderRegion', 'orderNo'],
      referencedTable: 'dbo.Orders',
      referencedColumns: ['region', 'orderNo'],
    });

    // Parent's reverse one-to-many joins its composite PK to the child's FK
    // columns, with matching arity.
    expect(config.entities.Order.relationships!.lines).toMatchObject({
      cardinality: 'many',
      'target.entity': 'LineItem',
      'source.fields': ['region', 'orderNo'],
      'target.fields': ['orderRegion', 'orderNo'],
    });
  });

  it('throws on an arity mismatch between explicit source and target fields', () => {
    @entity()
    class Warehouse extends Source({
      table: 'Warehouses',
      primaryKey: ['region', 'whNo'],
    }) {
      @text()
      region!: string;
      @int()
      whNo!: number;
      // Composite source key (2) mapped to a single target column (1).
      @many(() => Bin, {
        sourceFields: ['region', 'whNo'],
        targetFields: ['binKey'],
      })
      bins?: Bin[];
    }
    @entity()
    class Bin extends Source({ table: 'Bins', primaryKey: ['binKey'] }) {
      @uuid()
      binKey!: string;
    }

    expect(() => buildConfig(Warehouse, Bin)).toThrow(
      /maps 2 source key column\(s\) to 1 target column\(s\)/
    );
  });

  it('throws on an arity mismatch between explicit source and target fields (@one)', () => {
    @entity()
    class Warehouse extends Source({
      table: 'Warehouses',
      primaryKey: ['region', 'whNo'],
    }) {
      @text()
      region!: string;
      @int()
      whNo!: number;
    }
    @entity()
    class Bin extends Source({ table: 'Bins', primaryKey: ['binKey'] }) {
      @uuid()
      binKey!: string;
      @text()
      warehouseRegion!: string;
      @int()
      warehouseNo!: number;
      // Composite source key (2) mapped to a single target column (1).
      @one(() => Warehouse, {
        sourceFields: ['warehouseRegion', 'warehouseNo'],
        targetFields: ['region'],
      })
      warehouse?: Warehouse;
    }

    expect(() => buildConfig(Bin, Warehouse)).toThrow(
      /maps 2 source key column\(s\) to 1 target column\(s\)/
    );
  });

  it('preserves declared primary key order and resolves real column names', () => {
    // Fields are declared in the opposite order to `primaryKey`, and each maps
    // to an explicit column name. `keyFields` must follow the declared key
    // order (`metricCode`, then `sensorId`) using resolved column names — not
    // field-declaration order, and not the property names. DAB's `_by_pk`
    // argument order and the `x-schema` PK constraint both depend on this.
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['metricCode', 'sensorId'],
    }) {
      @text({ column: 'sensor_id' })
      sensorId!: string; // declared first
      @text({ column: 'metric_code' })
      metricCode!: string; // declared second
    }

    const config = buildConfig(Reading);

    expect(config.entities.Reading.keyFields).toEqual([
      'metric_code',
      'sensor_id',
    ]);
  });
});

describe('connector primary key -> no phantom id injection', () => {
  it('leaves an entity keyless when no primary key is present', () => {
    @entity()
    class Ledger extends Source({ table: 'Ledgers' }) {
      @text()
      note!: string;
    }

    const [analyzed] = new ConnectorSchemaAnalyzer(
      [Ledger] as never,
      'mssql'
    ).analyzeEntities();

    // No synthetic `id` field is added, and no field is a primary key.
    expect(analyzed.fields.find((f) => f.name === 'id')).toBeUndefined();
    expect(analyzed.fields.some((f) => f.primaryKey)).toBe(false);

    const config = buildConfig(Ledger);
    // Keyless entity keeps its schema-qualified source and emits no `keyFields`
    // and no primary-key constraint.
    expect(config.entities.Ledger.source).toBe('dbo.Ledgers');
    expect(config.entities.Ledger.keyFields).toBeUndefined();
    expect(
      config.entities.Ledger['x-schema']!.constraints.primaryKey
    ).toBeUndefined();
  });
});

describe('connector entity source -> schema qualification', () => {
  it('qualifies the source as `schema.table` for a declared schema', () => {
    @entity()
    class Student extends Source({
      schema: 'many-to-many-warehouse',
      table: 'Student',
      primaryKey: ['studentId'],
    }) {
      @int({ column: 'StudentID' })
      studentId!: number;
      @text({ column: 'FullName', max: 120 })
      fullName!: string;
    }

    const config = buildConfig(Student);
    expect(config.entities.Student.source).toBe(
      'many-to-many-warehouse.Student'
    );
    expect(config.entities.Student.keyFields).toEqual(['StudentID']);
  });

  it('qualifies the source with the default schema when none is declared', () => {
    @entity()
    class Widget extends Source({
      table: 'Widgets',
      primaryKey: ['widgetId'],
    }) {
      @int({ column: 'WidgetID' })
      widgetId!: number;
    }

    const config = buildConfig(Widget);
    expect(config.entities.Widget.source).toBe('dbo.Widgets');
  });
});

describe('connector primary key -> declaration validation', () => {
  it('throws when a declared key names a field the entity does not have', () => {
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['deviceId', 'missingCol'],
    }) {
      @text()
      deviceId!: string;
    }

    expect(() => buildConfig(Reading)).toThrow(
      /Primary key 'missingCol' declared in Source\(\{ primaryKey \}\) is not a field/
    );
  });

  it('throws when a declared key is listed more than once', () => {
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['deviceId', 'deviceId'],
    }) {
      @text()
      deviceId!: string;
    }

    expect(() => buildConfig(Reading)).toThrow(
      /Primary key 'deviceId' is listed more than once/
    );
  });

  it('throws when a declared key names a relationship field, not a scalar column', () => {
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['deviceId'],
    }) {
      @text()
      deviceId!: string;
    }
    @entity()
    class Alert extends Source({
      table: 'Alerts',
      // `reading` is a navigation field (@one), not a real column.
      primaryKey: ['id', 'reading'],
    }) {
      @uuid()
      id!: string;
      @one(() => Reading)
      reading!: Reading;
    }

    expect(() => buildConfig(Reading, Alert)).toThrow(
      /Primary key 'reading' is a relationship field, not a scalar column/
    );
  });

  it('throws when a declared key names an optional/nullable field', () => {
    @entity()
    class Reading extends Source({
      table: 'Readings',
      primaryKey: ['deviceId', 'metricCode'],
    }) {
      @text()
      deviceId!: string;
      @text({ optional: true })
      metricCode?: string;
    }

    expect(() => buildConfig(Reading)).toThrow(
      /Primary key 'metricCode' is declared optional\/nullable.*must be NOT NULL/
    );
  });
});

describe('connector relationship -> sourceFields / targetFields validation', () => {
  it('throws when sourceFields names a field the host entity does not have', () => {
    @entity()
    class Order extends Source({
      table: 'Orders',
      primaryKey: ['id', 'lineNumber'],
    }) {
      @uuid()
      id!: string;
      @int()
      lineNumber!: number;
    }
    @entity()
    class OrderLine extends Source({ table: 'OrderLines' }) {
      @uuid()
      id!: string;
      @uuid()
      orderId!: string;
      @int()
      lineId!: number;
      @one(() => Order, {
        // `lineIdd` is a typo — not a field on OrderLine.
        sourceFields: ['orderId', 'lineIdd'],
        targetFields: ['id', 'lineNumber'],
      })
      order!: Order;
    }

    expect(() => buildConfig(Order, OrderLine)).toThrow(
      /Relationship 'order' declares sourceFields 'lineIdd', which is not a field of 'OrderLine'/
    );
  });

  it('throws when targetFields names a field the referenced entity does not have', () => {
    @entity()
    class Order extends Source({
      table: 'Orders',
      primaryKey: ['id', 'lineNumber'],
    }) {
      @uuid()
      id!: string;
      @int()
      lineNumber!: number;
    }
    @entity()
    class OrderLine extends Source({ table: 'OrderLines' }) {
      @uuid()
      id!: string;
      @uuid()
      orderId!: string;
      @int()
      lineId!: number;
      @one(() => Order, {
        sourceFields: ['orderId', 'lineId'],
        // `lineNumberr` is a typo — not a field on Order. Cast past the
        // compile-time `keyof Order` guard to exercise the runtime validation.
        targetFields: ['id', 'lineNumberr'] as unknown as (keyof Order)[],
      })
      order!: Order;
    }

    expect(() => buildConfig(Order, OrderLine)).toThrow(
      /Relationship 'order' declares targetFields 'lineNumberr', which is not a field of the referenced entity 'Order'/
    );
  });

  it('accepts sourceFields / targetFields that name real fields on both sides', () => {
    @entity()
    class Order extends Source({
      table: 'Orders',
      primaryKey: ['id', 'lineNumber'],
    }) {
      @uuid()
      id!: string;
      @int()
      lineNumber!: number;
    }
    @entity()
    class OrderLine extends Source({ table: 'OrderLines' }) {
      @uuid()
      id!: string;
      @uuid()
      orderId!: string;
      @int()
      lineId!: number;
      @one(() => Order, {
        sourceFields: ['orderId', 'lineId'],
        targetFields: ['id', 'lineNumber'],
      })
      order!: Order;
    }

    expect(() => buildConfig(Order, OrderLine)).not.toThrow();
  });
});

describe('connector relationship -> many-to-many not supported', () => {
  it('throws an actionable error when @many is declared on both sides', () => {
    @entity()
    class Student extends Source({
      table: 'Students',
      primaryKey: ['id'],
    }) {
      @uuid()
      id!: string;
      @many(() => Course)
      courses?: Course[];
    }
    @entity()
    class Course extends Source({
      table: 'Courses',
      primaryKey: ['id'],
    }) {
      @uuid()
      id!: string;
      @many(() => Student)
      students?: Student[];
    }

    // Bidirectional @many cannot infer the join table. The error must point the
    // user at the explicit-junction workaround (an @entity() + two @one edges).
    expect(() => buildConfig(Student, Course)).toThrow(
      /Many-to-many relationship detected.*Model it explicitly.*two @one relationships/s
    );
  });
});
