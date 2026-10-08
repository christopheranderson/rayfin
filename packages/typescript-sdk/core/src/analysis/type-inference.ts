/**
 * Type inference engine for converting TypeScript types to database types
 *
 * This module handles the core convention-based inference logic that powers
 * the ultra-simplified decorator system. It analyzes TypeScript type information
 * and field names to generate appropriate database types and constraints.
 */

import { EntityNameResolver } from '@microsoft/rayfin-lib';

import { PermissionAction } from '..';
import {
  EntityClass,
  FieldFormat,
  FieldMetadata,
  RelationshipTypes,
  getPrimaryKeyField,
} from '../schema.js';

import { AnalyzerDialect, getDialectConfig } from './dialect-config.js';
import { isMinorFixesOn } from './feature-gate.js';

/** @internal */
export interface InferredField {
  name: string;
  originalName: string;
  dbType: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  checkConstraint?: string;
  checkConstraintNameSuffix?: string;
  foreignKey?: {
    referencedEntity: string;
    referencedField: string;
  };
  isRelationship: boolean;
  relationshipType?: 'one-to-many' | 'many-to-one' | 'many-to-many';
  generatedForeignKeyColumn?: string; // For relationships, the auto-generated FK column name
  originalFieldMetadata?: FieldMetadata<any>;
  columnName?: string;
  sourceFields?: string[];
  targetFields?: string[];
}

/** @internal */
export interface EntityAnalysisResult {
  name: string;
  tableName: string;
  fields: InferredField[];
  permissions: { [role: string]: PermissionAction[] };
  source?: { schema: string; table: string };
}

/**
 * @internal
 * Connector-path field type. Forks {@link InferredField}'s `foreignKey` so the
 * connector analyzer can populate `referencedEntity` alone: a composite key has
 * no single referenced field, so `referencedField` is optional here — while the
 * shared data-path type keeps it required.
 */
export interface ConnectorInferredField extends Omit<
  InferredField,
  'foreignKey'
> {
  foreignKey?: {
    referencedEntity: string;
    /** Absent for composite keys, where no single referenced field is meaningful. */
    referencedField?: string;
  };
}

/**
 * @internal
 * Connector analysis result with ordered primary-key source column names.
 */
export interface ConnectorEntityAnalysisResult extends Omit<
  EntityAnalysisResult,
  'fields'
> {
  fields: ConnectorInferredField[];
  /**
   * Ordered key column names when the entity declared `Source({ primaryKey })`.
   * Absent for legacy single-`id` entities; an empty array marks a keyless table.
   */
  primaryKeyColumns?: string[];
}

/** @internal */
export class TypeInferenceEngine {
  private dialectConfig;

  constructor(dialect: AnalyzerDialect) {
    this.dialectConfig = getDialectConfig(dialect);
  }

  getDefaultPrimaryKeyType(): string {
    return this.dialectConfig.defaultIdType;
  }

  /**
   * Infer database type from TypeScript type and field name
   */
  inferDatabaseType(
    fieldMetadata: FieldMetadata<any>,
    fieldName: string
  ): {
    type: string;
    checkConstraint?: string;
    checkConstraintNameSuffix?: string;
  } {
    const config = this.dialectConfig;
    // Check-constraint expressions reference the SQL column, which may be
    // renamed via the `column` option, so use the column name when present.
    const constraintColumn = fieldMetadata.columnName ?? fieldName;
    // Handle union types, but exclude optional primitive types (T | undefined)
    if (fieldMetadata.enum) {
      // This is a true union type (enum), generate check constraints
      const enumValues = fieldMetadata.enum
        .map((v: string) => v.replace(/['"]/g, ''))
        .filter((v: string) => v !== 'undefined');

      const checkConstraint = config.checkConstraintTemplate(
        constraintColumn,
        enumValues
      );

      const maxLength = Math.max(...enumValues.map((v: string) => v.length));

      return {
        type: config.defaultStringType(maxLength),
        checkConstraint,
      };
    }

    switch (fieldMetadata.format) {
      case FieldFormat.Uuid:
        return { type: config.defaultIdType };

      case FieldFormat.Email: {
        const constraints: string[] = [
          config.emailConstraintTemplate(constraintColumn),
        ];
        if (fieldMetadata.min !== undefined && fieldMetadata.min > 0) {
          constraints.push(
            config.minLengthConstraintTemplate(
              constraintColumn,
              fieldMetadata.min
            )
          );
        }

        return {
          type: fieldMetadata.max
            ? config.defaultStringType(fieldMetadata.max)
            : config.defaultTextType,
          checkConstraint: constraints.join(' AND '),
          checkConstraintNameSuffix: '_email',
        };
      }

      case FieldFormat.Text: {
        const hasMinLength =
          fieldMetadata.min !== undefined && fieldMetadata.min > 0;
        return {
          type: fieldMetadata.max
            ? config.defaultStringType(fieldMetadata.max)
            : config.defaultTextType,
          checkConstraint: hasMinLength
            ? config.minLengthConstraintTemplate(
                constraintColumn,
                fieldMetadata.min!
              )
            : undefined,
          checkConstraintNameSuffix: hasMinLength ? '_minlen' : undefined,
        };
      }

      case FieldFormat.Int: {
        const minorFixesOn = isMinorFixesOn();
        const hasRange =
          minorFixesOn &&
          (fieldMetadata.min !== undefined || fieldMetadata.max !== undefined);
        return {
          type: config.defaultIntegerType,
          checkConstraint: hasRange
            ? config.numericRangeConstraintTemplate(
                constraintColumn,
                fieldMetadata.min,
                fieldMetadata.max
              )
            : undefined,
          checkConstraintNameSuffix: hasRange ? '_range' : undefined,
        };
      }

      case FieldFormat.Boolean:
        return { type: config.defaultBooleanType };

      case FieldFormat.Date:
        return { type: config.defaultDateType };

      case FieldFormat.Decimal: {
        const minorFixesOn = isMinorFixesOn();
        const hasRange =
          minorFixesOn &&
          (fieldMetadata.min !== undefined || fieldMetadata.max !== undefined);
        return {
          type: config.defaultDecimalType(
            fieldMetadata.precision,
            fieldMetadata.scale
          ),
          checkConstraint: hasRange
            ? config.numericRangeConstraintTemplate(
                constraintColumn,
                fieldMetadata.min,
                fieldMetadata.max
              )
            : undefined,
          checkConstraintNameSuffix: hasRange ? '_range' : undefined,
        };
      }

      default:
        // Handle array types (relationships)
        if (fieldMetadata?.relationship?.type === RelationshipTypes.many) {
          return { type: 'RELATIONSHIP_ARRAY' }; // Special marker for relationship processing
        }

        // Handle custom types (single entity relationships)
        if (fieldMetadata?.relationship?.type === RelationshipTypes.one) {
          return { type: 'RELATIONSHIP_SINGLE' }; // Special marker for relationship processing
        }

        // Fallback to string for unknown types
        return { type: config.defaultStringType() };
    }
  }

  /**
   * Infer if a field should be a primary key
   */
  inferPrimaryKey(fieldName: string): boolean {
    // Strict match: only lowercase 'id' is a valid PK per the IEntity contract
    return fieldName === getPrimaryKeyField();
  }

  /**
   * Infer unique constraint
   */
  inferUniqueConstraint(
    _fieldName: string,
    hasExplicitUniqueDecorator: boolean
  ): boolean {
    // Explicit @unique() decorator always takes precedence
    if (hasExplicitUniqueDecorator) {
      return true;
    }

    return false;
  }

  /**
   * Infer nullability from TypeScript optional/required operators
   */
  inferNullability(isOptional: boolean): boolean {
    // TypeScript ? operator → nullable = true
    if (isOptional) {
      return true;
    }

    // Default: required fields are not nullable
    return false;
  }

  /**
   * Analyze relationships and generate foreign key information
   */
  analyzeRelationship(
    fieldName: string,
    fieldMetadata: FieldMetadata<any>
  ): {
    isRelationship: boolean;
    relationshipType?: 'one-to-many' | 'many-to-one' | 'many-to-many';
    referencedEntity?: string;
    generatedForeignKeyColumn?: string;
  } {
    if (fieldMetadata.relationship === undefined) {
      return { isRelationship: false };
    }

    const referencedEntity = this.resolveRelationshipTargetName(
      fieldMetadata.relationship.target
    );

    if (fieldMetadata.relationship.type === RelationshipTypes.many) {
      return {
        isRelationship: true,
        relationshipType: 'one-to-many',
        referencedEntity,
      };
    }

    if (fieldMetadata.relationship.type === RelationshipTypes.one) {
      const foreignKeyColumn = `${fieldName}_${getPrimaryKeyField()}`; // Auto-generate FK column name

      return {
        isRelationship: true,
        relationshipType: 'many-to-one',
        referencedEntity,
        generatedForeignKeyColumn: foreignKeyColumn,
      };
    }

    throw new Error(`Unknown relationship type for field ${fieldName}`);
  }

  private resolveRelationshipTargetName(
    target: () => EntityClass<any>
  ): string | undefined {
    try {
      const resolved = target();
      if (typeof resolved === 'function' && (resolved as any).name) {
        return (resolved as any).name;
      }
    } catch {
      // Target lambda threw — likely a typo, broken import, or non-class value
    }

    return undefined;
  }

  /**
   * Generate entity table name from class name (pluralized for database convention)
   */
  generateTableName(className: string): string {
    return EntityNameResolver.getPlural(className);
  }

  /**
   * Generate entity name for DAB config (preserves original TypeScript casing)
   */
  generateEntityName(className: string): string {
    return className;
  }

  /**
   * Check if a type string represents a custom (entity) type
   */
  private isCustomType(typeString: string): boolean {
    const builtInTypes = [
      'string',
      'number',
      'boolean',
      'Date',
      'undefined',
      'null',
      'void',
      'any',
      'unknown',
      'object',
      'Array',
      'Promise',
      'Function',
    ];

    return (
      !builtInTypes.includes(typeString) &&
      !typeString.includes('|') &&
      !typeString.includes('&') &&
      !typeString.endsWith('[]')
    );
  }
}
