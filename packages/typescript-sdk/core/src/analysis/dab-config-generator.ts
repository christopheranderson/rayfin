/**
 * Data API Builder (DAB) configuration generator
 *
 * Converts analyzed TypeScript entities into complete DAB configuration JSON.
 * Handles relationships, permissions, x-schema generation, and multi-dialect support.
 */

import { PermissionAction, SimpleAction, ComplexAction } from '..';
import { getPrimaryKeyField } from '../schema.js';
import { isFeatureFlagEnabled } from '../utils/feature-flags.js';

import { AnalyzerDialect, getDialectConfig } from './dialect-config.js';
import { EntityAnalysisResult } from './type-inference.js';

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
export interface Entity {
  source: string;
  permissions: Array<{
    role: string;
    actions: PermissionAction[];
  }>;
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
export class ConfigGenerator {
  private dialectConfig;
  private entities: EntityAnalysisResult[] = [];
  private junctionTables: Set<string> = new Set();

  constructor(dialect: AnalyzerDialect) {
    this.dialectConfig = getDialectConfig(dialect);
  }

  generateConfig(entities: EntityAnalysisResult[]): Config {
    this.entities = entities;

    // Analyze relationships and detect junction tables
    this.analyzeRelationships();

    const generatedEntities = this.generateEntities();

    // NOTE: User entity is NOT injected into user app DAB configs.
    // Users table exists only in the control plane database.

    const config: Config = {
      $schema:
        'https://github.com/Azure/data-api-builder/releases/download/v1.5.56/dab.draft.schema.json',
      entities: generatedEntities,
    };

    return config;
  }

  private analyzeRelationships(): void {
    // Detect many-to-many relationships that require junction tables
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
            `Many-to-many relationship detected between ${entityA.name} and ${entityB.name}. This is not currently supported.`
          );
        }

        // Check for bidirectional one-to-one relationships (not supported)
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
        // Skip system User entity; never include in app DAB configs.
        continue;
      }
      entities[entity.name] = this.generateEntity(entity);
    }

    return entities;
  }

  private generateEntity(entity: EntityAnalysisResult): Entity {
    // Generate DAB permissions
    const permissions: Array<{ role: string; actions: PermissionAction[] }> =
      [];

    // Default permissions if none specified
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

    // Generate relationships
    const relationships = this.generateRelationships(entity);

    // Generate mappings for foreign key columns
    const mappings = this.generateMappings(entity);

    // Generate x-schema extension
    const xSchema = this.generateXSchema(entity);

    const _entity: Entity = {
      source: entity.source?.table ?? entity.tableName,
      permissions,
      'x-schema': xSchema,
    };

    // Add optional properties
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
      // Handle simple string actions
      if (typeof action === 'string') {
        return action as SimpleAction;
      }

      // Handle complex action objects
      if (typeof action === 'object' && action !== null && 'action' in action) {
        const complexAction: ComplexAction = {
          action: (action as ComplexAction).action,
        };

        // Add fields if present
        if ('fields' in action && action.fields) {
          complexAction.fields = action.fields;
        }

        // Add policy if present
        if ('policy' in action && action.policy) {
          complexAction.policy = action.policy;
        }

        return complexAction;
      }

      // Fallback for unexpected types - cast to SimpleAction
      return action as SimpleAction;
    });
  }

  private generateRelationships(
    entity: EntityAnalysisResult
  ): Record<string, Relationship> {
    const relationships: Record<string, Relationship> = {};

    for (const field of entity.fields) {
      if (!field.isRelationship) continue;

      const targetEntity =
        field.foreignKey?.referencedEntity ||
        field.originalFieldMetadata?.relationship?.target?.name;

      if (!targetEntity) continue;

      // Check if this is part of a many-to-many relationship
      const junctionTableName = this.generateJunctionTableName(
        entity.name,
        targetEntity
      );
      const isManyToMany = this.junctionTables.has(junctionTableName);

      if (isManyToMany && field.relationshipType === 'one-to-many') {
        // Many-to-many relationship with junction table
        const sourceFieldInJunction = `${entity.name}_${getPrimaryKeyField()}`;

        relationships[field.name] = {
          cardinality: 'many',
          'target.entity': targetEntity,
          linking: {
            entity: junctionTableName,
            'source.fields': [getPrimaryKeyField()],
            'target.fields': [sourceFieldInJunction],
          },
        };
      } else if (field.relationshipType === 'many-to-one') {
        // Simple many-to-one relationship
        relationships[field.name] = {
          cardinality: 'one',
          'target.entity': targetEntity,
          'source.fields': [
            field.generatedForeignKeyColumn || `${field.name}_id`,
          ],
          'target.fields': [
            this.getFieldNameForEntity(targetEntity, getPrimaryKeyField()),
          ],
        };
      } else if (field.relationshipType === 'one-to-many') {
        // Simple one-to-many relationship
        const targetFk =
          this.findForeignKeyFromEntityToEntity(targetEntity, entity.name) ||
          `${entity.name}_${getPrimaryKeyField()}`;
        const sourcePk = this.getFieldNameForEntity(
          entity.name,
          getPrimaryKeyField()
        );

        relationships[field.name] = {
          cardinality: 'many',
          'target.entity': targetEntity,
          'source.fields': [sourcePk],
          'target.fields': [targetFk],
        };
      }
    }

    return relationships;
  }

  private findForeignKeyFromEntityToEntity(
    sourceEntityName: string,
    referencedEntityName: string
  ): string | undefined {
    const sourceEntity = this.entities.find((e) => e.name === sourceEntityName);
    if (!sourceEntity) return undefined;

    const relationshipField = sourceEntity.fields.find(
      (f) =>
        f.isRelationship &&
        f.relationshipType === 'many-to-one' &&
        f.foreignKey?.referencedEntity === referencedEntityName
    );

    if (!relationshipField) return undefined;

    return (
      relationshipField.generatedForeignKeyColumn ||
      `${relationshipField.name}_id`
    );
  }

  /**
   * Emit DAB `mappings` entries (SQL column name → GraphQL field name) for
   * fields whose SQL column differs from the property name. The GraphQL field
   * is exposed under the property name; without this block a `@column()` rename
   * would be silently dropped and DAB would expose the raw column name.
   */
  private generateMappings(
    entity: EntityAnalysisResult
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

  private generateXSchema(entity: EntityAnalysisResult): XSchemaExtension {
    const fields: Record<string, XSchemaField> = {};
    const relationshipNames: string[] = [];
    const foreignKeys: Array<{
      name: string;
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    }> = [];

    let primaryKey: { name: string; columns: string[] } | undefined;
    const uniqueConstraints: Array<{ name: string; columns: string[] }> = [];
    const checkConstraints: Array<{ name: string; expression: string }> = [];

    // Unidirectional one-to-many relationships (only the collection side is declared)
    // still need a foreign key column and constraint on the target entity.
    // Example: Category.todos: Todo[] implies Todo.category_id FK -> Categories.id.
    const incomingOneToMany = this.getIncomingOneToManyRelationships(
      entity.name
    );

    // Check for ambiguous relationships (multiple @many from same source entity)
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

        // Add auto-generated foreign key column for many-to-one relationships
        if (
          field.relationshipType === 'many-to-one' &&
          field.generatedForeignKeyColumn
        ) {
          const fkColumnName = field.generatedForeignKeyColumn;
          // cli-minor-fixes: preserve an explicitly declared FK field's options
          // (nullability, defaults, uniqueness) instead of overwriting them.
          const preserveExplicitFk = isFeatureFlagEnabled('cli-minor-fixes');
          if (!preserveExplicitFk || !fields[fkColumnName]) {
            fields[fkColumnName] = {
              dbType: this.dialectConfig.defaultIdType,
              nullable: field.nullable,
            };
          }

          // Add to foreign key constraints
          foreignKeys.push({
            name: `FK_${entity.tableName}_${fkColumnName}`,
            columns: [fkColumnName],
            referencedTable: this.getTableNameForEntity(
              field.foreignKey!.referencedEntity
            ),
            referencedColumns: [
              this.getFieldNameForEntity(
                field.foreignKey!.referencedEntity,
                getPrimaryKeyField()
              ),
            ],
          });
        }
      } else {
        // Regular field
        const columnName = field.columnName ?? field.name;

        const fieldDef: XSchemaField = {
          dbType: field.dbType,
          nullable: field.nullable,
        };

        // Include default value if specified in field metadata
        if (field.originalFieldMetadata?.default !== undefined) {
          fieldDef.defaultValue = field.originalFieldMetadata.default;
        }

        fields[columnName] = fieldDef;

        // Add to constraints
        if (field.primaryKey) {
          primaryKey = {
            name: `PK_${entity.tableName}`,
            columns: [columnName],
          };
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
    // Skip many-to-many pairs (those use junction tables instead).
    for (const incoming of incomingOneToMany) {
      const junctionTableName = this.generateJunctionTableName(
        incoming.sourceEntityName,
        entity.name
      );
      if (this.junctionTables.has(junctionTableName)) {
        continue;
      }

      // Skip inferred FK generation when an explicit many-to-one exists.
      const explicitFkColumn = this.findForeignKeyFromEntityToEntity(
        entity.name,
        incoming.sourceEntityName
      );
      if (explicitFkColumn) {
        continue;
      }

      const fkColumnName = `${incoming.sourceEntityName}_${getPrimaryKeyField()}`;

      // Avoid duplicating an explicit FK column.
      if (!fields[fkColumnName]) {
        fields[fkColumnName] = {
          dbType: this.dialectConfig.defaultIdType,
          nullable: false,
        };
      }

      // Avoid duplicating an explicit foreign key constraint.
      const fkName = `FK_${entity.tableName}_${fkColumnName}`;
      const alreadyHasFk = foreignKeys.some((fk) => fk.name === fkName);
      if (!alreadyHasFk) {
        foreignKeys.push({
          name: fkName,
          columns: [fkColumnName],
          referencedTable: this.getTableNameForEntity(
            incoming.sourceEntityName
          ),
          referencedColumns: [
            this.getFieldNameForEntity(
              incoming.sourceEntityName,
              getPrimaryKeyField()
            ),
          ],
        });
      }
    }

    const constraints: XSchemaExtension['constraints'] = {};

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
    // User is a system entity and will not be found in this.entities
    // Mapping table name for the entity type
    return (
      entity?.source?.table ||
      entity?.tableName ||
      (entityName === SYSTEM_ENTITIES.USER.ENTITY_NAME
        ? SYSTEM_ENTITIES.USER.TABLE_NAME
        : entityName)
    );
  }

  /**
   * Resolve the SQL column name for a field on the named entity, honoring
   * `@column()` renames so cross-entity FK referencedColumns point at the
   * actual column rather than the TypeScript property name.
   */
  private getFieldNameForEntity(entityName: string, fieldName: string): string {
    // For system User entity, use property names directly from User class
    if (entityName === SYSTEM_ENTITIES.USER.ENTITY_NAME) {
      return this.getSystemUserFieldName(fieldName);
    }

    // For user entities, find original field casing from analysis
    const entity = this.entities.find((e) => e.name === entityName);
    const field = entity?.fields.find(
      (f) => f.name.toLowerCase() === fieldName.toLowerCase()
    );
    return field?.columnName ?? field?.name ?? fieldName;
  }

  /**
   * Get the proper casing of system User entity fields.
   * Maps from lowercase field names to the actual User class property names.
   */
  private getSystemUserFieldName(fieldName: string): string {
    // Get actual property names from User class, preserving original casing
    const userFieldMap: Record<string, string> = {
      id: 'Id',
      email: 'Email',
    };
    return userFieldMap[fieldName.toLowerCase()] || fieldName;
  }

  private generateJunctionTableName(entityA: string, entityB: string): string {
    // Sort alphabetically for consistent naming
    const [first, second] = [entityA, entityB].sort();
    return `${first}_${second}`;
  }
}
