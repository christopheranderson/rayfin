/**
 * Analyzes connector entity metadata and resolves source tables, permissions,
 * fields, relationships, and primary-key columns.
 */

import {
  PermissionAction,
  PermissionConfig,
  RoleDeclaration,
  SimpleAction,
  FieldPermissions,
  ComplexAction,
} from '../options.js';
import { claims, createItemProxy } from '../policy.js';
import {
  EntityClass,
  EntityMetadata,
  FieldMetadata,
  getEntityMetadata,
  StorageFolderClass,
  FieldType,
} from '../schema.js';

import {
  AnalyzerDialect,
  ConnectorDialect,
  DatabaseDialect,
  DialectConfig,
  getDialectConfig,
} from './dialect-config.js';
import { isMinorFixesOn } from './feature-gate.js';
import { checkReservedEntityName } from './reserved-entity-names.js';
import {
  TypeInferenceEngine,
  ConnectorEntityAnalysisResult,
  ConnectorInferredField,
} from './type-inference.js';
import { ValidationErrorCollector } from './validation-errors.js';

/** @internal */
export type Schema = Array<EntityClass | StorageFolderClass>;

/** Maximum number of entities allowed in a single schema. */
/** @internal */
export const MAX_ENTITIES = 100;

/** @internal */
export interface ConnectorSchemaAnalyzerOptions {
  log?: (message: string) => void;
}

/** @internal */
export class ConnectorSchemaAnalyzer {
  private typeInference: TypeInferenceEngine;
  private schema: Schema;
  private errorCollector: ValidationErrorCollector;
  private dialectConfig: DialectConfig;
  private dialect: AnalyzerDialect;
  private log: (message: string) => void;

  constructor(
    schema: Schema,
    dialect: AnalyzerDialect,
    options: ConnectorSchemaAnalyzerOptions = {}
  ) {
    this.schema = schema;
    this.dialect = dialect;
    this.typeInference = new TypeInferenceEngine(dialect);
    this.errorCollector = new ValidationErrorCollector();
    this.dialectConfig = getDialectConfig(dialect);
    this.log = options.log ?? console.log;
  }

  /**
   * Analyze all entities in the provided TypeScript files.
   */
  analyzeEntities(): ConnectorEntityAnalysisResult[] {
    // Reset validation errors.
    this.errorCollector = new ValidationErrorCollector();
    const entities: ConnectorEntityAnalysisResult[] = [];

    // Count entity classes in the schema.
    const entityCount = this.schema.filter(
      (item) => getEntityMetadata(item) !== undefined
    ).length;

    if (entityCount > MAX_ENTITIES) {
      this.errorCollector.addError({
        entity: 'Schema',
        message: `Schema contains ${entityCount} entities, which exceeds the maximum of ${MAX_ENTITIES}`,
        fix: `Please use fewer entities`,
      });
      this.errorCollector.throwIfErrors();
    }

    for (const entity of this.schema) {
      const classInfo = getEntityMetadata(entity);
      // hoistMetadataFromFields(new entity() as EntityInstance<any>, classInfo);
      if (classInfo) {
        // Reject entities whose name collides with a GraphQL type the
        // platform already defines. GraphQL type names are global across the
        // workload's schema, so the workload fails `applyconfig` with an
        // opaque schema-build error that names neither entity nor connector.
        const reservedError = checkReservedEntityName(classInfo.name, {
          supportsSourceMapping: true,
        });
        if (reservedError) {
          this.errorCollector.addError(reservedError);
          continue;
        }

        this.log(`   ✅ Found @entity class: ${classInfo.name}`);
        const analysisResult = this.analyzeEntity(classInfo);
        entities.push(analysisResult);
      }
    }

    // Validate relationship targets across entities.
    const entityNames = new Set(entities.map((e) => e.name));
    const fieldNamesByEntity = new Map(
      entities.map((e) => [e.name, new Set(e.fields.map((f) => f.name))])
    );
    for (const entity of entities) {
      const hostFieldNames = fieldNamesByEntity.get(entity.name)!;
      for (const field of entity.fields) {
        if (!field.isRelationship) continue;

        if (
          field.foreignKey?.referencedEntity &&
          !entityNames.has(field.foreignKey.referencedEntity)
        ) {
          this.errorCollector.addError({
            entity: entity.name,
            field: field.name,
            message: `Relationship '${field.name}' references entity '${field.foreignKey.referencedEntity}', but it is not included in the schema`,
            fix: `Add the '${field.foreignKey.referencedEntity}' class to the schema array, and/or ensure it is decorated with @entity()`,
          });
        }

        // Validate explicit `sourceFields` name real fields on the host entity.
        // An unresolved name would otherwise pass through untouched and surface
        // only as a runtime "invalid column" error against the source table.
        if (field.sourceFields) {
          for (const prop of field.sourceFields) {
            if (!hostFieldNames.has(prop)) {
              this.errorCollector.addError({
                entity: entity.name,
                field: field.name,
                message: `Relationship '${field.name}' declares sourceFields '${prop}', which is not a field of '${entity.name}'.`,
                fix: `Use a property declared on '${entity.name}', or correct the sourceFields entry.`,
              });
            }
          }
        }

        // Validate explicit `targetFields` name real fields on the referenced
        // entity. Skipped when the target is not an in-schema entity (a missing
        // target is already reported above).
        const referencedEntity = field.foreignKey?.referencedEntity;
        const targetFieldNames = referencedEntity
          ? fieldNamesByEntity.get(referencedEntity)
          : undefined;
        if (field.targetFields && targetFieldNames) {
          for (const prop of field.targetFields) {
            if (!targetFieldNames.has(prop)) {
              this.errorCollector.addError({
                entity: entity.name,
                field: field.name,
                message: `Relationship '${field.name}' declares targetFields '${prop}', which is not a field of the referenced entity '${referencedEntity}'.`,
                fix: `Use a property declared on '${referencedEntity}', or correct the targetFields entry.`,
              });
            }
          }
        }
      }
    }

    // Validate that no two entities bind to the same source table. Two
    // entities resolving to the same schema+table produce duplicate
    // source-table bindings that the workload rejects late during
    // `applyconfig` with a cryptic host error. Catch it here with an
    // actionable message naming both entities and the conflicting table.
    const defaultSchema = this.dialectConfig.defaultSchema ?? '';
    const bindingOwner = new Map<string, string>();
    for (const entity of entities) {
      const schema = entity.source?.schema ?? defaultSchema;
      const table = entity.source?.table ?? entity.tableName;
      const displayTable = schema ? `${schema}.${table}` : table;
      const bindingKey = `${schema}.${table}`.toLowerCase();
      const existing = bindingOwner.get(bindingKey);
      if (existing) {
        this.errorCollector.addError({
          entity: entity.name,
          message: `Entity '${entity.name}' binds to source table '${displayTable}', which is already bound by entity '${existing}'. Each entity must map to a distinct source table.`,
          fix: `Point '${entity.name}' at a different table via Source({ table: '...' }), or remove the duplicate entity.`,
        });
      } else {
        bindingOwner.set(bindingKey, entity.name);
      }
    }

    // Throw collected validation errors.
    this.errorCollector.throwIfErrors();

    return entities;
  }

  /**
   * Analyze an entity and generate connector configuration.
   */
  private analyzeEntity(
    classInfo: EntityMetadata
  ): ConnectorEntityAnalysisResult {
    const entityName = this.typeInference.generateEntityName(classInfo.name);
    const tableName = this.typeInference.generateTableName(classInfo.name);

    // Entity-level ordered key declared via `Source({ primaryKey: [...] })`.
    // undefined => legacy; [] => keyless; [...] => composite or custom key.
    const declaredKeys = classInfo.source?.primaryKey;

    // Reject schema-qualified entity and table names.
    if (entityName.includes('.') || tableName.includes('.')) {
      this.errorCollector.addError({
        entity: classInfo.name,
        message: `Entity name '${classInfo.name}' contains a '.'. Only the default database schema is supported; do not include a '.' in the entity name.`,
        fix: `Remove the '.' from the class name.`,
      });
    }

    const permissions = this.aggregatePermissions(classInfo, 'database');

    // Validate field metadata.
    this.validateFieldMetadata(classInfo);

    // Analyze fields.
    const fields: ConnectorInferredField[] = [];
    const fieldNamesSeen = new Map<string, string>(); // normalized name -> original name

    for (const [fieldName, fieldInfo] of Object.entries(classInfo.fields)) {
      this.log(`   🔎 Analyzing field: ${fieldName}`);
      this.log(`       Info: ${JSON.stringify(fieldInfo)}`);

      // Check for case-insensitive duplicate field names.
      const normalizedFieldName = fieldName.toLowerCase();
      if (fieldNamesSeen.has(normalizedFieldName)) {
        const existingFieldName = fieldNamesSeen.get(normalizedFieldName)!;
        this.errorCollector.addError({
          entity: classInfo.name,
          field: fieldName,
          message: `Duplicate field name detected: '${fieldName}' collides with '${existingFieldName}' (case-insensitive collision)`,
          fix: `Rename one of the fields to ensure all field names are unique`,
        });
      }
      fieldNamesSeen.set(normalizedFieldName, fieldName);

      const inferredField = this.analyzeField(
        fieldName,
        fieldInfo,
        declaredKeys
      );
      fields.push(inferredField);
    }

    // Validate the declared key: every entry must name a distinct scalar
    // column of the entity. A relationship (navigation) field is not a real
    // column, and a repeated entry produces a duplicate column in the emitted
    // keyFields — both fail far downstream at DAB / the database with a much
    // less actionable message, so they are caught here where the fix hint can
    // name the offending key.
    if (declaredKeys) {
      const seenKeys = new Set<string>();
      for (const key of declaredKeys) {
        if (!Object.prototype.hasOwnProperty.call(classInfo.fields, key)) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: key,
            message: `Primary key '${key}' declared in Source({ primaryKey }) is not a field of '${classInfo.name}'.`,
            fix: `Add a field named '${key}' or correct the primaryKey entry.`,
          });
          continue;
        }

        if (seenKeys.has(key)) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: key,
            message: `Primary key '${key}' is listed more than once in Source({ primaryKey }).`,
            fix: `Remove the duplicate '${key}' entry.`,
          });
        }
        seenKeys.add(key);

        if (classInfo.fields[key].relationship) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: key,
            message: `Primary key '${key}' is a relationship field, not a scalar column.`,
            fix: `Use the underlying scalar column(s) instead of the relationship '${key}'.`,
          });
        } else if (classInfo.fields[key].isOptional) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: key,
            message: `Primary key '${key}' is declared optional/nullable ('${key}?'), but primary key columns must be NOT NULL.`,
            fix: `Make '${key}' required (remove the '?'), or remove it from Source({ primaryKey }).`,
          });
        }
      }
    }

    // Leave connector entities keyless when no key is declared.
    const hasPrimaryKey = fields.some((f) => f.primaryKey);
    if (declaredKeys === undefined && !hasPrimaryKey) {
      console.log(
        `   ⚠️  No primary key declared for ${classInfo.name}; leaving it keyless. ` +
          `Declare one explicitly via Source({ primaryKey: [...] }) if the table has a key.`
      );
    }

    // Validate relationships and foreign key conflicts.
    this.validateRelationships(classInfo, fields);

    this.log(
      `   📊 ${entityName}: ${fields.length} fields, ${Object.keys(permissions).length} permission roles`
    );

    // Resolve declared key property names to source column names.
    // undefined => legacy; [] => keyless; [...] => composite/custom.
    const primaryKeyColumns = declaredKeys
      ? declaredKeys.map((key) => {
          const field = fields.find((f) => f.name === key);
          return field?.columnName ?? key;
        })
      : undefined;

    return {
      name: entityName,
      tableName,
      fields,
      permissions,
      ...(primaryKeyColumns ? { primaryKeyColumns } : {}),
      ...(classInfo.source
        ? { source: this.resolveSource(classInfo.source, entityName) }
        : {}),
    };
  }

  /**
   * Resolve a `Source({...})` payload to the source schema and table.
   */
  private resolveSource(
    rawSource: { schema?: string; table?: string },
    entityName: string
  ): { schema: string; table: string } {
    return {
      schema: rawSource.schema ?? this.dialectConfig.defaultSchema ?? '',
      table: rawSource.table ?? entityName,
    };
  }

  private aggregatePermissions(
    meta: EntityMetadata,
    context: 'database' | 'storage'
  ): PermissionConfig {
    // Use legacy permissions when no roles are declared.
    if (!meta.roles || meta.roles.length === 0) {
      return meta.permissions || {};
    }

    const result: PermissionConfig = {};

    // Sort roles by name.
    const rolesByName = new Map<string, RoleDeclaration[]>();
    for (const decl of meta.roles) {
      const arr = rolesByName.get(decl.role) || [];
      arr.push(decl);
      rolesByName.set(decl.role, arr);
    }

    const sortedRoleNames = Array.from(rolesByName.keys()).sort();

    for (const roleName of sortedRoleNames) {
      const decls = rolesByName.get(roleName)!;
      const actionsForRole: PermissionAction[] = [];

      for (const decl of decls) {
        const actions = this.sortActions(decl.actions);
        for (const action of actions) {
          const policyString = decl.policy
            ? decl.policy.check(claims, createItemProxy()).toString()
            : undefined;

          const hasInclude =
            decl.includedFields && decl.includedFields.length > 0;
          const hasExclude =
            decl.excludedFields && decl.excludedFields.length > 0;

          if (hasInclude || hasExclude || policyString) {
            const complex: ComplexAction = { action };
            if (policyString) {
              complex.policy =
                context === 'storage'
                  ? { storage: policyString }
                  : { database: policyString };
            }
            if (hasInclude || hasExclude) {
              const fields: FieldPermissions = {};
              if (hasInclude) {
                fields.include = [...decl.includedFields!].sort();
              }
              if (hasExclude) {
                fields.exclude = [...decl.excludedFields!].sort();
              }
              if (!fields.include && fields.exclude) {
                fields.include = ['*'];
              }
              complex.fields = fields;
            }
            actionsForRole.push(complex);
          } else {
            actionsForRole.push(action as SimpleAction);
          }
        }
      }

      result[roleName] = actionsForRole;
    }

    return result;
  }

  private sortActions(actions: SimpleAction[]): SimpleAction[] {
    const order: Record<SimpleAction, number> = {
      create: 1,
      read: 2,
      update: 3,
      delete: 4,
      execute: 5,
      '*': 99,
    } as const;
    return [...actions].sort((a, b) => order[a] - order[b]);
  }

  /**
   * Analyze a single field and apply inference rules.
   */
  private analyzeField(
    fieldName: string,
    fieldInfo: FieldMetadata<FieldType>,
    declaredKeys?: readonly string[]
  ): ConnectorInferredField {
    // Check for explicit constraint decorators.
    const hasExplicitUnique = !!fieldInfo.isUnique;

    // Apply type inference.
    const typeResult = this.typeInference.inferDatabaseType(
      fieldInfo,
      fieldName
    );
    const nullable = this.typeInference.inferNullability(
      !!fieldInfo.isOptional
    );
    // A field is a primary key only when the entity declared it via
    // `Source({ primaryKey: [...] })`. No key declared => keyless, so no
    // by-key surface is generated.
    const primaryKey = declaredKeys ? declaredKeys.includes(fieldName) : false;
    const unique = this.typeInference.inferUniqueConstraint(
      fieldName,
      hasExplicitUnique
    );

    // Analyze relationships.
    const relationshipInfo = this.typeInference.analyzeRelationship(
      fieldName,
      fieldInfo
    );

    return {
      name: fieldName,
      originalName: fieldName,
      dbType: typeResult.type,
      nullable: primaryKey ? false : nullable, // Primary keys are never nullable
      primaryKey,
      unique,
      checkConstraint: typeResult.checkConstraint,
      checkConstraintNameSuffix: typeResult.checkConstraintNameSuffix,
      foreignKey: relationshipInfo.referencedEntity
        ? {
            referencedEntity: relationshipInfo.referencedEntity,
          }
        : undefined,
      isRelationship: relationshipInfo.isRelationship,
      relationshipType: relationshipInfo.relationshipType,
      generatedForeignKeyColumn: relationshipInfo.generatedForeignKeyColumn,
      originalFieldMetadata: fieldInfo,
      columnName: fieldInfo.columnName,
      sourceFields: fieldInfo.relationship?.sourceFields,
      targetFields: fieldInfo.relationship?.targetFields,
    };
  }

  /**
   * Validate field metadata.
   */
  private validateFieldMetadata(classInfo: EntityMetadata): void {
    for (const [fieldName, fieldInfo] of Object.entries(classInfo.fields)) {
      // Connector primary-key fields may use any field format.

      // Validate text field options.
      if (fieldInfo.format === 'text' || fieldInfo.format === 'email') {
        // Flag off ⇒ treat all values as finite (matches pre-PR behavior).
        const minorFixesOn = isMinorFixesOn();
        const hasFiniteMin =
          !minorFixesOn ||
          fieldInfo.min === undefined ||
          Number.isFinite(fieldInfo.min);
        const hasFiniteMax =
          !minorFixesOn ||
          fieldInfo.max === undefined ||
          Number.isFinite(fieldInfo.max);

        if (minorFixesOn && !hasFiniteMin) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid text field: min (${fieldInfo.min}) must be a finite number`,
            fix: `Set min to a finite non-negative value, e.g., @text({ min: 1 })`,
          });
        }

        if (minorFixesOn && !hasFiniteMax) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid text field: max (${fieldInfo.max}) must be a finite number`,
            fix: `Set max to a finite non-negative value, e.g., @text({ max: 255 })`,
          });
        }

        if (
          hasFiniteMin &&
          hasFiniteMax &&
          fieldInfo.min !== undefined &&
          fieldInfo.max !== undefined
        ) {
          if (fieldInfo.min > fieldInfo.max) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid text field: min (${fieldInfo.min}) must be less than or equal to max (${fieldInfo.max})`,
              fix: `Set min <= max, e.g., @text({ min: 1, max: 50 })`,
            });
          }
        }

        if (hasFiniteMin && fieldInfo.min !== undefined && fieldInfo.min < 0) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid text field: min (${fieldInfo.min}) cannot be negative`,
            fix: `Set min to a non-negative value, e.g., @text({ min: 0 })`,
          });
        }

        if (hasFiniteMax && fieldInfo.max !== undefined && fieldInfo.max < 0) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid text field: max (${fieldInfo.max}) cannot be negative`,
            fix: `Set max to a positive value, e.g., @text({ max: 255 })`,
          });
        }

        // Validate text length against the dialect maximum.
        const maxStringLength = this.dialectConfig.maxStringLength;
        if (
          hasFiniteMax &&
          fieldInfo.max !== undefined &&
          maxStringLength !== null &&
          fieldInfo.max > maxStringLength
        ) {
          const unbounded = this.dialectConfig.defaultTextType;
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Text field max (${fieldInfo.max}) exceeds the maximum sized string length (${maxStringLength}) for ${this.dialect.toUpperCase()}. Use @text() without a max option for unbounded text`,
            fix: `Set max to ${maxStringLength} or less, or remove the max option to use ${unbounded}`,
          });
        }

        // Validate unique constraints on unbounded text fields.
        if (
          fieldInfo.isUnique &&
          fieldInfo.max === undefined &&
          (this.dialect === DatabaseDialect.MsSql ||
            this.dialect === ConnectorDialect.FabricWarehouse ||
            this.dialect === ConnectorDialect.FabricSqlAnalytics)
        ) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Unique constraint on unbounded text field is not supported in MSSQL. SQL Server cannot create unique indexes on NVARCHAR(MAX) columns`,
            fix: `Add a max length, e.g., @text({ unique: true, max: 255 })`,
          });
        }
      }

      // Validate int and decimal field options.
      if (fieldInfo.format === 'int' || fieldInfo.format === 'decimal') {
        // Flag off ⇒ treat all values as finite (matches pre-PR behavior).
        const minorFixesOn = isMinorFixesOn();
        const hasFiniteMin =
          !minorFixesOn ||
          fieldInfo.min === undefined ||
          Number.isFinite(fieldInfo.min);
        const hasFiniteMax =
          !minorFixesOn ||
          fieldInfo.max === undefined ||
          Number.isFinite(fieldInfo.max);

        if (minorFixesOn && !hasFiniteMin) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid numeric field: min (${fieldInfo.min}) must be a finite number`,
            fix: `Set min to a finite number, e.g., @int({ min: 0 })`,
          });
        }

        if (minorFixesOn && !hasFiniteMax) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid numeric field: max (${fieldInfo.max}) must be a finite number`,
            fix: `Set max to a finite number, e.g., @int({ max: 100 })`,
          });
        }

        if (
          hasFiniteMin &&
          hasFiniteMax &&
          fieldInfo.min !== undefined &&
          fieldInfo.max !== undefined
        ) {
          if (fieldInfo.min > fieldInfo.max) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid numeric field: min (${fieldInfo.min}) must be less than or equal to max (${fieldInfo.max})`,
              fix: `Set min <= max, e.g., @int({ min: 0, max: 100 })`,
            });
          }
        }
      }

      // Validate decimal precision and scale options.
      if (fieldInfo.format === 'decimal') {
        const hasPrecision = fieldInfo.precision !== undefined;
        const hasScale = fieldInfo.scale !== undefined;

        if (hasPrecision !== hasScale) {
          const defined = hasPrecision ? 'precision' : 'scale';
          const missing = hasPrecision ? 'scale' : 'precision';
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid decimal field: '${defined}' is defined without '${missing}'. Both must be specified together`,
            fix: `Add the missing option, e.g., @decimal({ precision: 10, scale: 2 })`,
          });
        }

        if (hasPrecision && hasScale) {
          const precision = fieldInfo.precision!;
          const scale = fieldInfo.scale!;
          const maxPrecision = this.dialectConfig.maxDecimalPrecision;

          if (!Number.isInteger(precision)) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid decimal field: precision (${precision}) must be an integer`,
              fix: `Use a whole number, e.g., @decimal({ precision: 10, scale: 2 })`,
            });
          }

          if (!Number.isInteger(scale)) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid decimal field: scale (${scale}) must be an integer`,
              fix: `Use a whole number, e.g., @decimal({ precision: 10, scale: 2 })`,
            });
          }

          if (precision < 1) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid decimal field: precision (${precision}) must be at least 1`,
              fix: `Set precision to a value between 1 and ${maxPrecision}, e.g., @decimal({ precision: 10, scale: 2 })`,
            });
          }

          if (precision > maxPrecision) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid decimal field: precision (${precision}) exceeds the maximum of ${maxPrecision} for this dialect`,
              fix: `Set precision to a value between 1 and ${maxPrecision}, e.g., @decimal({ precision: ${Math.min(18, maxPrecision)}, scale: 2 })`,
            });
          }

          if (scale < 0) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid decimal field: scale (${scale}) cannot be negative`,
              fix: `Set scale to a value between 0 and precision (${precision}), e.g., @decimal({ precision: ${precision}, scale: 2 })`,
            });
          }

          if (scale > precision) {
            this.errorCollector.addError({
              entity: classInfo.name,
              field: fieldName,
              message: `Invalid decimal field: scale (${scale}) cannot exceed precision (${precision})`,
              fix: `Set scale <= precision, e.g., @decimal({ precision: ${precision}, scale: ${Math.min(2, precision)} })`,
            });
          }
        }
      }

      // Validate set and enum field options.
      if (fieldInfo.enum) {
        if (fieldInfo.enum.length === 0) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid set field: enum must have at least one value`,
            fix: `Provide at least one enum value, e.g., @set('option1', 'option2')`,
          });
        }

        // Check for case-sensitive duplicate enum values.
        const enumValues = fieldInfo.enum as string[];
        const uniqueValues = new Set(enumValues);
        if (uniqueValues.size !== enumValues.length) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid set field: enum values must be unique`,
            fix: `Remove duplicate values from the set, e.g., @set('option1', 'option2') instead of @set('option1', 'option1')`,
          });
        }
      }
    }
  }

  /**
   * Validate relationships and foreign key conflicts.
   */
  private validateRelationships(
    classInfo: EntityMetadata,
    fields: ConnectorInferredField[]
  ): void {
    // Check each relationship field for unresolved targets and FK conflicts.
    for (const field of fields) {
      // Validate that relationship targets resolved successfully.
      if (field.isRelationship && !field.foreignKey?.referencedEntity) {
        this.errorCollector.addError({
          entity: classInfo.name,
          field: field.name,
          message: `Relationship '${field.name}' could not resolve its target entity`,
          fix: `Ensure the target class exists, is imported correctly, and is passed to the schema array`,
        });
      }

      // Reject required self-referencing many-to-one relationships.
      if (
        field.isRelationship &&
        field.relationshipType === 'many-to-one' &&
        field.foreignKey?.referencedEntity === classInfo.name &&
        !field.nullable
      ) {
        this.errorCollector.addError({
          entity: classInfo.name,
          field: field.name,
          message: `Self-referencing relationship '${classInfo.name}.${field.name}' must be optional; a required self-referencing foreign key cannot be satisfied when inserting the first row because no parent row exists yet`,
          fix: `Mark the relationship optional, e.g. @one(() => ${classInfo.name}, { optional: true }) ${field.name}?: ${classInfo.name};`,
        });
      }

      if (field.isRelationship && field.generatedForeignKeyColumn) {
        // Generated foreign-key column types are resolved during config generation.
      }
    }
  }
}
