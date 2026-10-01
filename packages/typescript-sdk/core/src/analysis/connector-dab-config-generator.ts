/**
 * Connector-path Data API Builder (DAB) configuration generator.
 *
 * Generates connector DAB configs with entity sources, permissions,
 * relationships, mappings, and x-schema metadata.
 */

import { PermissionAction, SimpleAction, ComplexAction } from '..';

import { AnalyzerDialect, getDialectConfig } from './dialect-config.js';
import type { ConnectorEntityAnalysisResult } from './type-inference.js';

const SYSTEM_ENTITIES = {
  USER: {
    ENTITY_NAME: 'User',
    TABLE_NAME: 'Users',
  },
} as const;

/** @internal */
export interface Config {
  $schema: string;
  entities: Record<string, Entity>;
}

/** @internal */
/**
 * DAB entity `source` as a table name or object-form source.
 */
export type EntitySource =
  | string
  | {
      object: string;
      type: 'table' | 'view' | 'stored-procedure';
    };

/** @internal */
export interface Entity {
  source: EntitySource;
  permissions: Array<{
    role: string;
    actions: PermissionAction[];
  }>;
  keyFields?: string[];
  relationships?: Record<string, Relationship>;
  mappings?: Record<string, string>;
  'x-schema'?: XSchemaExtension;
}

/** @internal */
export interface Relationship {
  cardinality: 'one' | 'many';
  'target.entity': string;
  'source.fields'?: string[];
  'target.fields'?: string[];
  linking?: {
    entity: string;
    'source.fields': string[];
    'target.fields': string[];
  };
}

/** @internal */
export interface XSchemaExtension {
  fields: Record<string, XSchemaField>;
  constraints: {
    primaryKey?: {
      name: string;
      columns: string[];
    };
    foreignKeys?: Array<{
      name: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    }>;
    uniqueConstraints?: Array<{
      name: string;
      columns: string[];
    }>;
    checkConstraints?: Array<{
      name: string;
      expression: string;
    }>;
  };
}

/** @internal */
export interface XSchemaField {
  dbType: string;
  nullable: boolean;
  defaultValue?: string | number | boolean;
}

/** @internal */
export class ConnectorConfigGenerator {
  private dialectConfig;
  private entities: ConnectorEntityAnalysisResult[] = [];

  constructor(dialect: AnalyzerDialect) {
    this.dialectConfig = getDialectConfig(dialect);
  }

  generateConfig(entities: ConnectorEntityAnalysisResult[]): Config {
    this.entities = entities;

    // Analyze relationships and detect junction tables.
    this.analyzeRelationships();

    const generatedEntities = this.generateEntities();

    // Omit the User entity from app DAB configs.

    const config: Config = {
      $schema:
        'https://github.com/Azure/data-api-builder/releases/download/v1.5.56/dab.draft.schema.json',
      entities: generatedEntities,
    };

    return config;
  }

  private analyzeRelationships(): void {
    // Detect many-to-many relationships that require junction tables.
    for (let i = 0; i < this.entities.length; i++) {
      for (let j = i + 1; j < this.entities.length; j++) {
        const entityA = this.entities[i];
        const entityB = this.entities[j];

        const aHasArrayOfB = entityA.fields.some(
          (field) =>
            field.isRelationship &&
            field.relationshipType === 'one-to-many' &&
            field.foreignKey?.referencedEntity === entityB.name
        );

        const bHasArrayOfA = entityB.fields.some(
          (field) =>
            field.isRelationship &&
            field.relationshipType === 'one-to-many' &&
            field.foreignKey?.referencedEntity === entityA.name
        );

        if (aHasArrayOfB && bHasArrayOfA) {
          throw new Error(
            `Many-to-many relationship detected between '${entityA.name}' and '${entityB.name}'. ` +
              `Declaring many-to-many by putting @many on both sides is not supported — the join ` +
              `table cannot be inferred (on a connector it already exists in your database). ` +
              `Model it explicitly: add an @entity() for the join table with two @one relationships, ` +
              `one to each side. This supports composite keys.`
          );
        }

        // Check for bidirectional one-to-one relationships.
        const aHasOneB = entityA.fields.some(
          (field) =>
            field.isRelationship &&
            field.relationshipType === 'many-to-one' &&
            field.foreignKey?.referencedEntity === entityB.name
        );

        const bHasOneA = entityB.fields.some(
          (field) =>
            field.isRelationship &&
            field.relationshipType === 'many-to-one' &&
            field.foreignKey?.referencedEntity === entityA.name
        );

        if (aHasOneB && bHasOneA) {
          throw new Error(
            `One-to-one relationship detected between ${entityA.name} and ${entityB.name}. This is not currently supported.`
          );
        }
      }
    }
  }

  private generateEntities(): Record<string, Entity> {
    const entities: Record<string, Entity> = {};

    for (const entity of this.entities) {
      if (entity.name === SYSTEM_ENTITIES.USER.ENTITY_NAME) {
        // Skip the system User entity.
        continue;
      }
      entities[entity.name] = this.generateEntity(entity);
    }

    return entities;
  }

  private generateEntity(entity: ConnectorEntityAnalysisResult): Entity {
    // Generate DAB permissions.
    const permissions: Array<{ role: string; actions: PermissionAction[] }> =
      [];

    // Add default permissions when none are specified.
    const permissionKeys = Object.keys(entity.permissions);
    if (permissionKeys.length === 0) {
      permissions.push({ role: 'authenticated', actions: ['*'] });
    } else {
      for (const role of permissionKeys.sort()) {
        const actions = entity.permissions[role];
        const dabActions = this.transformPermissionActions(actions);
        permissions.push({ role, actions: dabActions });
      }
    }

    // Generate relationships.
    const relationships = this.generateRelationships(entity);

    // Generate mappings for foreign key columns.
    const mappings = this.generateMappings(entity);

    // Generate the x-schema extension.
    const xSchema = this.generateXSchema(entity);

    const tableName = entity.source?.table ?? entity.tableName;
    const schemaName = entity.source?.schema;
    const keyFields = entity.primaryKeyColumns;

    // Qualify the source as `schema.table` so it resolves under the declared
    // schema instead of the backend default.
    const source: EntitySource = schemaName
      ? `${schemaName}.${tableName}`
      : tableName;

    const _entity: Entity = {
      source,
      permissions,
      'x-schema': xSchema,
    };

    // Emit the primary key at the top level as `keyFields`; this is the only
    // place the BaaS backend reads connector keys from.
    if (keyFields && keyFields.length > 0) {
      _entity.keyFields = [...keyFields];
    }

    // Add optional properties.
    if (Object.keys(relationships).length > 0) {
      _entity.relationships = relationships;
    }

    if (Object.keys(mappings).length > 0) {
      _entity.mappings = mappings;
    }

    return _entity;
  }

  private transformPermissionActions(
    actions: PermissionAction[]
  ): PermissionAction[] {
    return actions.map((action) => {
      // Handle simple string actions.
      if (typeof action === 'string') {
        return action as SimpleAction;
      }

      // Handle complex action objects.
      if (typeof action === 'object' && action !== null && 'action' in action) {
        const complexAction: ComplexAction = {
          action: (action as ComplexAction).action,
        };

        // Add fields when present.
        if ('fields' in action && action.fields) {
          complexAction.fields = action.fields;
        }

        // Add policy when present.
        if ('policy' in action && action.policy) {
          complexAction.policy = action.policy;
        }

        return complexAction;
      }

      // Cast unexpected action values to simple actions.
      return action as SimpleAction;
    });
  }

  private generateRelationships(
    entity: ConnectorEntityAnalysisResult
  ): Record<string, Relationship> {
    const relationships: Record<string, Relationship> = {};

    for (const field of entity.fields) {
      if (!field.isRelationship) continue;

      const targetEntity =
        field.foreignKey?.referencedEntity ||
        field.originalFieldMetadata?.relationship?.target?.name;

      if (!targetEntity) continue;

      if (field.relationshipType === 'many-to-one') {
        // Add a many-to-one relationship using the target key columns.
        const fkColumns = this.buildForeignKeyColumns(
          field.name,
          targetEntity,
          this.resolveExplicitSourceColumns(entity, field.sourceFields)
        );
        const sourceFields = (
          field.sourceFields ?? fkColumns.map((c) => c.column)
        ).map((f) => this.getFieldNameForEntity(entity.name, f));
        const targetFields = (
          field.targetFields ?? fkColumns.map((c) => c.referencedColumn)
        ).map((f) => this.getFieldNameForEntity(targetEntity, f));
        this.assertMatchingArity(
          entity.name,
          field.name,
          sourceFields,
          targetFields
        );
        relationships[field.name] = {
          cardinality: 'one',
          'target.entity': targetEntity,
          'source.fields': sourceFields,
          'target.fields': targetFields,
        };
      } else if (field.relationshipType === 'one-to-many') {
        // Add a one-to-many relationship using target-side FK columns.
        const sourcePkColumns = this.getReferencedKeyColumns(entity.name);
        const explicitTargetFkColumns = this.findForeignKeyFromEntityToEntity(
          targetEntity,
          entity.name
        );
        const targetFkColumns =
          explicitTargetFkColumns.length > 0
            ? explicitTargetFkColumns
            : sourcePkColumns.map((pk) => `${entity.name}_${pk}`);

        const sourceFields = (field.sourceFields ?? sourcePkColumns).map((f) =>
          this.getFieldNameForEntity(entity.name, f)
        );
        const targetFields = (field.targetFields ?? targetFkColumns).map((f) =>
          this.getFieldNameForEntity(targetEntity, f)
        );
        this.assertMatchingArity(
          entity.name,
          field.name,
          sourceFields,
          targetFields
        );

        relationships[field.name] = {
          cardinality: 'many',
          'target.entity': targetEntity,
          'source.fields': sourceFields,
          'target.fields': targetFields,
        };
      }
    }

    return relationships;
  }

  /**
   * Guard that an explicit relationship mapping pairs each source column with
   * exactly one target column. Without this, a mismatched mapping is silently
   * truncated downstream by `buildForeignKeyColumns` into a plausible-looking
   * but wrong config. Shared by the many-to-one and one-to-many branches.
   */
  private assertMatchingArity(
    entityName: string,
    fieldName: string,
    sourceFields: string[],
    targetFields: string[]
  ): void {
    if (sourceFields.length !== targetFields.length) {
      throw new Error(
        `Relationship '${fieldName}' on entity '${entityName}' maps ${sourceFields.length} source key column(s) to ${targetFields.length} target column(s). Specify matching 'sourceFields' and 'targetFields'.`
      );
    }
  }

  private findForeignKeyFromEntityToEntity(
    sourceEntityName: string,
    referencedEntityName: string
  ): string[] {
    const sourceEntity = this.entities.find((e) => e.name === sourceEntityName);
    if (!sourceEntity) return [];

    const relationshipField = sourceEntity.fields.find(
      (f) =>
        f.isRelationship &&
        f.relationshipType === 'many-to-one' &&
        f.foreignKey?.referencedEntity === referencedEntityName
    );

    if (!relationshipField) return [];

    // Mirror the forward many-to-one branch: one FK column per referenced key
    // column, so a composite key yields a matching-arity column list.
    return this.buildForeignKeyColumns(
      relationshipField.name,
      referencedEntityName,
      this.resolveExplicitSourceColumns(
        sourceEntity,
        relationshipField.sourceFields
      )
    ).map((fk) => fk.column);
  }

  /**
   * Returns the ordered SQL column names for an entity's primary key.
   * Uses declared key columns or discovered primary-key fields. A known entity
   * with no key is keyless and returns an empty list.
   */
  private getReferencedKeyColumns(entityName: string): string[] {
    const entity = this.entities.find((e) => e.name === entityName);
    if (entity) {
      if (entity.primaryKeyColumns && entity.primaryKeyColumns.length > 0) {
        return [...entity.primaryKeyColumns];
      }
      const pkFields = entity.fields.filter((f) => f.primaryKey);
      if (pkFields.length > 0) {
        return pkFields.map((f) => f.columnName ?? f.name);
      }
      // Known connector entity with no declared key: keyless.
      return [];
    }
    return [];
  }

  /**
   * Resolves explicit relationship `sourceFields` to SQL column names.
   * Returns `undefined` when no explicit source fields were declared.
   */
  private resolveExplicitSourceColumns(
    entity: ConnectorEntityAnalysisResult,
    sourceFields: string[] | undefined
  ): string[] | undefined {
    if (!sourceFields) return undefined;
    return sourceFields.map((prop) => {
      const field = entity.fields.find((f) => f.name === prop);
      return field?.columnName ?? field?.name ?? prop;
    });
  }

  /**
   * Builds ordered local and referenced column pairs for a foreign key.
   * Includes the dbType for synthesized local FK columns.
   */
  private buildForeignKeyColumns(
    baseName: string,
    referencedEntityName: string,
    explicitSourceColumns: string[] | undefined
  ): Array<{ column: string; referencedColumn: string; dbType: string }> {
    const referencedColumns =
      this.getReferencedKeyColumns(referencedEntityName);
    const referencedEntity = this.entities.find(
      (e) => e.name === referencedEntityName
    );

    return referencedColumns.map((referencedColumn, index) => {
      let column: string;
      if (explicitSourceColumns && explicitSourceColumns[index] !== undefined) {
        column = explicitSourceColumns[index];
      } else {
        column = `${baseName}_${referencedColumn}`;
      }

      const referencedField = referencedEntity?.fields.find(
        (f) => (f.columnName ?? f.name) === referencedColumn
      );
      return {
        column,
        referencedColumn,
        dbType: referencedField?.dbType ?? this.dialectConfig.defaultIdType,
      };
    });
  }

  /**
   * Emits DAB mappings from SQL column names to GraphQL field names. The
   * GraphQL field is exposed under the property name; a mapping is emitted only
   * when the physical column name differs.
   */
  private generateMappings(
    entity: ConnectorEntityAnalysisResult
  ): Record<string, string> {
    const mappings: Record<string, string> = {};

    for (const field of entity.fields) {
      if (field.isRelationship) continue;

      const columnName = field.columnName ?? field.name;

      if (columnName !== field.name) {
        mappings[columnName] = field.name;
      }
    }

    return mappings;
  }

  private generateXSchema(
    entity: ConnectorEntityAnalysisResult
  ): XSchemaExtension {
    const fields: Record<string, XSchemaField> = {};
    const relationshipNames: string[] = [];
    const foreignKeys: Array<{
      name: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    }> = [];

    let primaryKey: { name: string; columns: string[] } | undefined;
    // Connector path: accumulate ALL primary-key columns (composite/custom) so
    // a multi-column key is preserved instead of collapsing to the last field.
    const primaryKeyColumns: string[] = [];
    const uniqueConstraints: Array<{ name: string; columns: string[] }> = [];
    const checkConstraints: Array<{ name: string; expression: string }> = [];

    // Get incoming one-to-many relationships for target-side FK generation.
    const incomingOneToMany = this.getIncomingOneToManyRelationships(
      entity.name
    );

    // Check for ambiguous relationships from the same source entity.
    const sourceCounts = new Map<string, number>();
    for (const incoming of incomingOneToMany) {
      const count = sourceCounts.get(incoming.sourceEntityName) || 0;
      sourceCounts.set(incoming.sourceEntityName, count + 1);
    }

    for (const [sourceName, count] of sourceCounts) {
      if (count > 1) {
        throw new Error(
          `Ambiguous relationship detected: Entity '${sourceName}' has multiple @many relationships to '${entity.name}'. ` +
            `Rayfin cannot infer distinct foreign keys. You must define explicit @one relationships on '${entity.name}' to specify distinct foreign keys.`
        );
      }
    }

    for (const field of entity.fields) {
      if (field.isRelationship) {
        relationshipNames.push(field.name);

        // Add generated foreign key columns for many-to-one relationships.
        if (
          field.relationshipType === 'many-to-one' &&
          field.generatedForeignKeyColumn
        ) {
          const referencedEntity = field.foreignKey!.referencedEntity;

          // Build one FK column per referenced key column.
          const explicitSources = this.resolveExplicitSourceColumns(
            entity,
            field.sourceFields
          );
          const fkColumns = this.buildForeignKeyColumns(
            field.name,
            referencedEntity,
            explicitSources
          );

          // Add generated FK-backing columns not provided by sourceFields.
          fkColumns.forEach((fk, index) => {
            const isExplicit =
              !!explicitSources && explicitSources[index] !== undefined;
            if (!isExplicit && !fields[fk.column]) {
              fields[fk.column] = {
                dbType: fk.dbType,
                nullable: field.nullable,
              };
            }
          });

          // Resolve referenced columns from targetFields or referenced keys.
          const referencedColumns =
            field.targetFields && field.targetFields.length === fkColumns.length
              ? field.targetFields.map((t) =>
                  this.getFieldNameForEntity(referencedEntity, t)
                )
              : fkColumns.map((fk) => fk.referencedColumn);

          const fkColumnNames = fkColumns.map((fk) => fk.column);

          // Add foreign key constraints.
          foreignKeys.push({
            name: `FK_${entity.tableName}_${fkColumnNames.join('_')}`,
            columns: fkColumnNames,
            referencedTable: this.getTableNameForEntity(referencedEntity),
            referencedColumns,
          });
        }
      } else {
        // Add a regular field.
        const columnName = field.columnName ?? field.name;

        const fieldDef: XSchemaField = {
          dbType: field.dbType,
          nullable: field.nullable,
        };

        // Include a default value from field metadata.
        if (field.originalFieldMetadata?.default !== undefined) {
          fieldDef.defaultValue = field.originalFieldMetadata.default;
        }

        fields[columnName] = fieldDef;

        // Add field constraints.
        if (field.primaryKey) {
          primaryKeyColumns.push(columnName);
        }

        if (field.unique && !field.primaryKey) {
          uniqueConstraints.push({
            name: `UQ_${entity.tableName}_${columnName}`,
            columns: [columnName],
          });
        }

        if (field.checkConstraint) {
          checkConstraints.push({
            name: `CK_${entity.tableName}_${columnName}${field.checkConstraintNameSuffix ?? ''}`,
            expression: field.checkConstraint,
          });
        }
      }
    }

    // Add inferred foreign keys for incoming one-to-many relationships.
    for (const incoming of incomingOneToMany) {
      // Skip inferred FK generation when an explicit many-to-one exists.
      const explicitFkColumn = this.findForeignKeyFromEntityToEntity(
        entity.name,
        incoming.sourceEntityName
      );
      if (explicitFkColumn) {
        continue;
      }

      const referencedEntity = incoming.sourceEntityName;

      // Build one FK column per referenced key column.
      const fkColumns = this.buildForeignKeyColumns(
        referencedEntity,
        referencedEntity,
        undefined
      );

      // Avoid duplicating explicit FK columns.
      for (const fk of fkColumns) {
        if (!fields[fk.column]) {
          fields[fk.column] = {
            dbType: fk.dbType,
            nullable: false,
          };
        }
      }

      const fkColumnNames = fkColumns.map((fk) => fk.column);

      // Avoid duplicating an explicit foreign key constraint.
      const fkName = `FK_${entity.tableName}_${fkColumnNames.join('_')}`;
      const alreadyHasFk = foreignKeys.some((fk) => fk.name === fkName);
      if (!alreadyHasFk) {
        foreignKeys.push({
          name: fkName,
          columns: fkColumnNames,
          referencedTable: this.getTableNameForEntity(referencedEntity),
          referencedColumns: fkColumns.map((fk) => fk.referencedColumn),
        });
      }
    }

    const constraints: XSchemaExtension['constraints'] = {};

    // Use declared primary-key order when present.
    const orderedPkColumns =
      entity.primaryKeyColumns && entity.primaryKeyColumns.length > 0
        ? [...entity.primaryKeyColumns]
        : primaryKeyColumns;
    if (orderedPkColumns.length > 0) {
      primaryKey = {
        name: `PK_${entity.tableName}`,
        columns: orderedPkColumns,
      };
    }

    if (primaryKey) constraints.primaryKey = primaryKey;
    if (foreignKeys.length > 0) constraints.foreignKeys = foreignKeys;
    if (uniqueConstraints.length > 0)
      constraints.uniqueConstraints = uniqueConstraints;
    if (checkConstraints.length > 0)
      constraints.checkConstraints = checkConstraints;

    return {
      fields,
      constraints,
    };
  }

  private getIncomingOneToManyRelationships(
    targetEntityName: string
  ): Array<{ sourceEntityName: string }> {
    const incoming: Array<{ sourceEntityName: string }> = [];

    for (const sourceEntity of this.entities) {
      for (const field of sourceEntity.fields) {
        if (!field.isRelationship || field.relationshipType !== 'one-to-many') {
          continue;
        }

        const referencedEntity =
          field.foreignKey?.referencedEntity ||
          field.originalFieldMetadata?.relationship?.target?.name;

        if (referencedEntity !== targetEntityName) {
          continue;
        }

        incoming.push({ sourceEntityName: sourceEntity.name });
      }
    }

    return incoming;
  }

  private getTableNameForEntity(entityName: string): string {
    const entity = this.entities.find((e) => e.name === entityName);
    // Map the entity name to its table name.
    const table =
      entity?.source?.table ||
      entity?.tableName ||
      (entityName === SYSTEM_ENTITIES.USER.ENTITY_NAME
        ? SYSTEM_ENTITIES.USER.TABLE_NAME
        : entityName);

    // Qualify the referenced table as `schema.table` so foreign-key targets
    // resolve under the declared schema instead of the backend default.
    const schema = entity?.source?.schema;
    return schema ? `${schema}.${table}` : table;
  }

  /**
   * Resolves the SQL column name for a field on the named entity.
   */
  private getFieldNameForEntity(entityName: string, fieldName: string): string {
    // Resolve system User fields.
    if (entityName === SYSTEM_ENTITIES.USER.ENTITY_NAME) {
      return this.getSystemUserFieldName(fieldName);
    }

    // Resolve user entity fields from analysis.
    const entity = this.entities.find((e) => e.name === entityName);
    const field = entity?.fields.find(
      (f) => f.name.toLowerCase() === fieldName.toLowerCase()
    );
    return field?.columnName ?? field?.name ?? fieldName;
  }

  /**
   * Maps system User field names to property names.
   */
  private getSystemUserFieldName(fieldName: string): string {
    // Map lowercase field names to User property names.
    const userFieldMap: Record<string, string> = {
      id: 'Id',
      email: 'Email',
    };
    return userFieldMap[fieldName.toLowerCase()] || fieldName;
  }
}
