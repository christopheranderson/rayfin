import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { ConnectorSchemaAnalyzer } from '../analysis/connector-schema-analyzer';
import { ConnectorDialect, DatabaseDialect } from '../analysis/dialect-config';
import {
  checkReservedEntityName,
  RESERVED_ENTITY_NAMES,
} from '../analysis/reserved-entity-names';
import { SchemaAnalyzer } from '../analysis/schema-analyzer';
import { SchemaValidationError } from '../analysis/validation-errors';
import { entity, text, uuid } from '../decorators/decorators';

/** Run the data-path analyzer and return the aggregated validation error. */
function analyzeData(schema: unknown[]): SchemaValidationError {
  const analyzer = new SchemaAnalyzer(schema as never, DatabaseDialect.MsSql);
  try {
    analyzer.analyzeEntities();
  } catch (error) {
    return error as SchemaValidationError;
  }
  throw new Error('Expected the analyzer to reject the schema');
}

/** Run the connector analyzer and return the aggregated validation error. */
function analyzeConnector(schema: unknown[]): SchemaValidationError {
  const analyzer = new ConnectorSchemaAnalyzer(
    schema as never,
    ConnectorDialect.FabricWarehouse,
    { log: () => {} }
  );
  try {
    analyzer.analyzeEntities();
  } catch (error) {
    return error as SchemaValidationError;
  }
  throw new Error('Expected the analyzer to reject the schema');
}

describe('checkReservedEntityName', () => {
  it('stays in sync with the list published in the decorator reference', () => {
    // Both skills tell agents to read the list from this doc, so a silent
    // divergence would have them generate names the analyzers reject.
    const guide = readFileSync(
      fileURLToPath(
        new URL('../../assets/docs/decorators.md', import.meta.url)
      ),
      'utf8'
    );
    const line = guide
      .split('\n')
      .find((l) => l.trim().startsWith('Reserved:'));
    expect(
      line,
      'decorator reference is missing the "Reserved:" list'
    ).toBeDefined();

    const documented = [...line!.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((name) => name !== '__');

    expect(documented).toEqual([...RESERVED_ENTITY_NAMES]);
  });

  it('allows names that only resemble a reserved type', () => {
    for (const name of ['Order', 'TaskDate', 'DateRange', 'date', 'INT']) {
      expect(
        checkReservedEntityName(name, { supportsSourceMapping: false })
      ).toBeUndefined();
    }
  });

  it('offers the Source escape hatch only where it applies', () => {
    const connector = checkReservedEntityName('Date', {
      supportsSourceMapping: true,
    });
    expect(connector?.fix).toContain("Source({ table: '...' })");

    const data = checkReservedEntityName('Date', {
      supportsSourceMapping: false,
    });
    expect(data?.fix).not.toContain('Source(');
    expect(data?.fix).toContain("@entity('...')");
  });

  it('suggests a replacement that is not itself reserved', () => {
    const result = checkReservedEntityName('__Meta', {
      supportsSourceMapping: false,
    });
    expect(result?.fix).toContain("'MetaRecord'");
    expect(
      checkReservedEntityName('MetaRecord', { supportsSourceMapping: false })
    ).toBeUndefined();
  });
});

describe('Reserved GraphQL type names - data path', () => {
  it('rejects a built-in scalar name', () => {
    @entity()
    class Date {
      @uuid() id!: string;
      @text() label!: string;
    }

    const error = analyzeData([Date]);
    expect(error).toBeInstanceOf(SchemaValidationError);
    expect(error.errors[0].entity).toBe('Date');
    expect(error.errors[0].message).toContain('built-in GraphQL scalar type');
    // The data path has no Source() mapping, so it must not suggest one.
    expect(error.errors[0].fix).not.toContain('Source(');
  });

  it('rejects an operation root type supplied via @entity()', () => {
    @entity('Mutation')
    class Audit {
      @uuid() id!: string;
    }

    expect(analyzeData([Audit]).errors[0].message).toMatch(
      /operation root type reserved/
    );
  });

  it('rejects an introspection prefix', () => {
    @entity()
    class __Internal {
      @uuid() id!: string;
    }

    expect(analyzeData([__Internal]).errors[0].message).toMatch(
      /reserves for introspection/
    );
  });

  it('accepts a case-sensitive near-match', () => {
    @entity()
    class TaskDate {
      @uuid() id!: string;
    }

    const analyzer = new SchemaAnalyzer([TaskDate], DatabaseDialect.MsSql);
    expect(analyzer.analyzeEntities().map((e) => e.name)).toEqual(['TaskDate']);
  });
});

describe('Reserved GraphQL type names - connector path', () => {
  it('rejects a built-in scalar name', () => {
    @entity()
    class Date {
      @uuid() id!: string;
    }

    const error = analyzeConnector([Date]);
    expect(error.errors[0].entity).toBe('Date');
    expect(error.errors[0].message).toContain('built-in GraphQL scalar type');
    expect(error.errors[0].fix).toContain("Source({ table: '...' })");
  });

  it('rejects an operation root type supplied via @entity()', () => {
    @entity('Query')
    class Lookup {
      @uuid() id!: string;
    }

    expect(analyzeConnector([Lookup]).errors[0].message).toMatch(
      /operation root type reserved/
    );
  });

  it('rejects an introspection prefix', () => {
    @entity()
    class __Meta {
      @uuid() id!: string;
    }

    expect(analyzeConnector([__Meta]).errors[0].message).toMatch(
      /reserves for introspection/
    );
  });

  it('accepts a case-sensitive near-match', () => {
    @entity()
    class TaskDate {
      @uuid() id!: string;
    }

    const analyzer = new ConnectorSchemaAnalyzer(
      [TaskDate] as never,
      ConnectorDialect.FabricWarehouse,
      { log: () => {} }
    );
    expect(analyzer.analyzeEntities().map((e) => e.name)).toEqual(['TaskDate']);
  });
});
