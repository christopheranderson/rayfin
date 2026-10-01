/**
 * Runtime metadata analyzer for the decorator system
 *
 * This module reads runtime metadata stored by decorators via Symbol.metadata.
 * It uses the TypeScript compiler APIs to extract type information and decorator
 * metadata for configuration generation.
 */

import {
  PermissionAction,
  PermissionConfig,
  RoleDeclaration,
  SimpleAction,
  FieldPermissions,
  ComplexAction,
} from '../options.js';
import { claims, createItemProxy, serializeCheckToAst } from '../policy.js';
import {
  EntityClass,
  EntityMetadata,
  FieldFormat,
  FieldMetadata,
  getEntityMetadata,
  StorageFolderClass,
  StorageFolderMetadata,
  tryGetStorageFolderMetadata,
  FieldType,
  getPrimaryKeyField,
} from '../schema.js';
import { SystemEntityNames } from '../system-entities.js';

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
  EntityAnalysisResult,
  InferredField,
} from './type-inference.js';
import { ValidationErrorCollector } from './validation-errors.js';

/** @internal */
export interface StorageFolderInfo {
  name: string;
  folderName: string;
  permissions: StorageFolderMetadata['permissions'];
  /** Server behavior on resolved-path collision. Defaults to `'error'`. */
  onConflict: 'error' | 'overwrite';
  /** Maximum object size (bytes number or unit string). Normalized at emit. */
  maxSize?: number | string;
  /** Allowed content types as MIME globs. Undefined/empty allows any type. */
  allowedContentTypes?: string[];
  /**
   * App-specific typed fields declared on the `@blob` class. Emitted into
   * the JSON DSL `fields[]` array and persisted to the
   * `storage.objects.user_metadata` JSON column at upload time.
   */
  fields: StorageFolderFieldInfo[];
}

/** @internal A single app-declared field on a `@blob` class. */
export interface StorageFolderFieldInfo {
  name: string;
  /** JavaScript-level type: `'string' | 'number' | 'boolean' | 'Date'`. */
  type: string;
  nullable: boolean;
}

/** @internal */
export type Schema = Array<EntityClass | StorageFolderClass>;

/**
 * Maximum number of entities allowed in a single schema.
 */
/** @internal */
export const MAX_ENTITIES = 100;

/**
 * Returns whether a relationship field declares explicit foreign-key columns
 * via `sourceFields` or `targetFields`.
 */
function hasCustomForeignKey(field: InferredField): boolean {
  return (
    field.isRelationship && Boolean(field.sourceFields || field.targetFields)
  );
}

/** @internal */
export interface SchemaAnalyzerOptions {
  log?: (message: string) => void;
}

/** @internal */
export class SchemaAnalyzer {
  private typeInference: TypeInferenceEngine;
  private schema: Schema;
  private errorCollector: ValidationErrorCollector;
  private dialectConfig: DialectConfig;
  private dialect: AnalyzerDialect;
  private log: (message: string) => void;

  constructor(
    schema: Schema,
    dialect: AnalyzerDialect,
    options: SchemaAnalyzerOptions = {}
  ) {
    this.schema = schema;
    this.dialect = dialect;
    this.typeInference = new TypeInferenceEngine(dialect);
    this.errorCollector = new ValidationErrorCollector();
    this.dialectConfig = getDialectConfig(dialect);
    this.log = options.log ?? console.log;
  }

  /**
   * Analyze all entities in the provided TypeScript files
   */
  analyzeEntities(): EntityAnalysisResult[] {
    // Reset error collector for fresh analysis
    this.errorCollector = new ValidationErrorCollector();
    const entities: EntityAnalysisResult[] = [];

    // Count entity classes in the schema (exclude storage folders)
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
        // Reject entities that use reserved system entity names
        if (SystemEntityNames.has(classInfo.name)) {
          this.errorCollector.addError({
            entity: classInfo.name,
            message: `'${classInfo.name}' is a built-in system entity and cannot be redefined`,
            fix: `Rename your class to avoid conflicting with the built-in '${classInfo.name}' entity`,
          });
          continue;
        }

        // Reject entities whose name collides with a GraphQL type the
        // generated schema already defines, which fails the deploy.
        const reservedError = checkReservedEntityName(classInfo.name, {
          supportsSourceMapping: false,
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

    // Cross-entity validation: check that relationship targets exist in the schema
    // System entities (like User) are always valid relationship targets
    const entityNames = new Set(entities.map((e) => e.name));
    for (const entity of entities) {
      for (const field of entity.fields) {
        if (
          field.isRelationship &&
          field.foreignKey?.referencedEntity &&
          !entityNames.has(field.foreignKey.referencedEntity) &&
          !SystemEntityNames.has(field.foreignKey.referencedEntity)
        ) {
          this.errorCollector.addError({
            entity: entity.name,
            field: field.name,
            message: `Relationship '${field.name}' references entity '${field.foreignKey.referencedEntity}', but it is not included in the schema`,
            fix: `Add the '${field.foreignKey.referencedEntity}' class to the schema array, and/or ensure it is decorated with @entity()`,
          });
        }
      }
    }

    // Throw all collected validation errors together
    this.errorCollector.throwIfErrors();

    return entities;
  }

  /**
   * Analyze all storage folders in the provided TypeScript files
   */
  analyzeStorageFolders(): StorageFolderInfo[] {
    const storageFolders: StorageFolderInfo[] = [];

    for (const item of this.schema) {
      const storageMeta = tryGetStorageFolderMetadata(
        item as StorageFolderClass
      );
      if (!storageMeta) {
        continue;
      }

      this.log(`   ✅ Found storage folder: ${storageMeta.name}`);

      const permissions =
        storageMeta.roles && storageMeta.roles.length > 0
          ? this.aggregatePermissions(
              {
                name: storageMeta.name,
                fields: {},
                permissions: storageMeta.permissions,
                roles: storageMeta.roles,
              } as EntityMetadata,
              'storage'
            )
          : storageMeta.permissions;

      const fields: StorageFolderFieldInfo[] = [];
      for (const [fieldName, fieldInfo] of Object.entries(
        storageMeta.fields ?? {}
      )) {
        fields.push({
          name: fieldName,
          type: fieldInfo.jsType ?? 'string',
          nullable: fieldInfo.isOptional === true,
        });
      }

      storageFolders.push({
        name: storageMeta.name,
        folderName: storageMeta.folderName,
        permissions,
        onConflict: storageMeta.onConflict,
        maxSize: storageMeta.maxSize,
        allowedContentTypes: storageMeta.allowedContentTypes,
        fields,
      });
    }

    return storageFolders;
  }

  /**
   * Analyze entity and generate complete configuration
   */
  private analyzeEntity(classInfo: EntityMetadata): EntityAnalysisResult {
    const entityName = this.typeInference.generateEntityName(classInfo.name);
    const tableName = this.typeInference.generateTableName(classInfo.name);

    // Source is connector-only. A data-path entity must never extend
    // Source({...}); the data path follows the `id` primary-key convention and
    // its DDL generator is single-`id`. Reject Source metadata here so
    // composite/custom keys expressed via Source({ primaryKey: [...] }) can
    // never reach the data-path DDL generator.
    if (classInfo.source) {
      this.errorCollector.addError({
        entity: classInfo.name,
        message: `Entity '${classInfo.name}' extends Source({...}), which is connector-only. The data path uses the 'id' primary-key convention and does not support Source-based schema/table mapping or composite/custom primary keys.`,
        fix: `Remove the Source({...}) base class from '${classInfo.name}', or use this entity through a connector instead.`,
      });
    }

    // Reject schema-qualified entity / table names (e.g., 'ops.MyTable').
    // Only the default database schema is supported, and dotted names would
    // otherwise be treated as a single literal table name and fail at apply time
    if (entityName.includes('.') || tableName.includes('.')) {
      this.errorCollector.addError({
        entity: classInfo.name,
        message: `Entity name '${classInfo.name}' contains a '.'. Only the default database schema is supported; do not include a '.' in the entity name.`,
        fix: `Remove the '.' from the class name.`,
      });
    }

    const permissions = this.aggregatePermissions(classInfo, 'database');

    // Validate field metadata before analysis
    this.validateFieldMetadata(classInfo);

    // Analyze each field
    const fields: InferredField[] = [];
    const fieldNamesSeen = new Map<string, string>(); // normalized name -> original name

    for (const [fieldName, fieldInfo] of Object.entries(classInfo.fields)) {
      this.log(`   🔎 Analyzing field: ${fieldName}`);
      this.log(`       Info: ${JSON.stringify(fieldInfo)}`);

      // Check for duplicate field names (case-insensitive)
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

      const inferredField = this.analyzeField(fieldName, fieldInfo);
      fields.push(inferredField);
    }

    // Ensure we have a primary key - show warning if missing, but add one implicitly
    const hasPrimaryKey = fields.some((f) => f.primaryKey);
    if (!hasPrimaryKey) {
      const defaultPk = getPrimaryKeyField();
      const conflicting = fields.find(
        (f) => f.name.toLowerCase() === defaultPk.toLowerCase()
      );
      if (conflicting) {
        this.errorCollector.addError({
          entity: classInfo.name,
          field: conflicting.name,
          message: `Field '${conflicting.name}' collides with the auto-generated '${defaultPk}' primary key column.`,
          fix: `Rename the field to lowercase '${defaultPk}' to make it the primary key, or pick a different name.`,
        });
      } else {
        this.log(
          `   ⚠️  No primary key found for ${classInfo.name}, adding default '${defaultPk}' field`
        );
        fields.unshift({
          name: defaultPk,
          originalName: defaultPk,
          dbType: this.typeInference.getDefaultPrimaryKeyType(),
          nullable: false,
          primaryKey: true,
          unique: false,
          isRelationship: false,
        });
      }
    }

    // Validate relationships and foreign key conflicts
    this.validateRelationships(classInfo, fields);

    this.log(
      `   📊 ${entityName}: ${fields.length} fields, ${Object.keys(permissions).length} permission roles`
    );

    return {
      name: entityName,
      tableName,
      fields,
      permissions,
      ...(classInfo.source
        ? { source: this.resolveSource(classInfo.source, entityName) }
        : {}),
    };
  }

  /**
   * Resolve a raw `Source({...})` payload from `@entity()` metadata into the
   * fully populated `{ schema, table }` exposed on the analysis result.
   *
   * - `schema` falls back to the dialect's default schema (`dbo` for MSSQL,
   *   `public` for PostgreSQL); an empty string is used as a last resort for
   *   dialects that have no concept of a default schema.
   * - `table` falls back to the resolved entity name, which is always present
   *   here (so anonymous class expressions still produce valid metadata).
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
    // Fallback to legacy permissions if no roles declared
    if (!meta.roles || meta.roles.length === 0) {
      return meta.permissions || {};
    }

    const result: PermissionConfig = {};

    // Deterministic role ordering
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
          // Evaluate the policy lambda once and derive both the legacy
          // diagnostic string and the JSON-AST form from the same
          // expression tree, so a storage rule can emit `check` verbatim.
          let policyString: string | undefined;
          let policyAst: ReturnType<typeof serializeCheckToAst> | undefined;
          if (decl.policy) {
            const expr = decl.policy.check(claims, createItemProxy());
            policyString = expr.toString();
            if (context === 'storage') {
              policyAst = serializeCheckToAst(expr);
            }
          }

          const hasInclude =
            decl.includedFields && decl.includedFields.length > 0;
          const hasExclude =
            decl.excludedFields && decl.excludedFields.length > 0;

          if (hasInclude || hasExclude || policyString) {
            const complex: ComplexAction = { action };
            if (policyString) {
              complex.policy =
                context === 'storage'
                  ? { storage: policyString, check: policyAst }
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
   * Analyze a single field and apply inference rules
   */
  private analyzeField(
    fieldName: string,
    fieldInfo: FieldMetadata<FieldType>
  ): InferredField {
    // Check for explicit constraint decorators
    const hasExplicitUnique = !!fieldInfo.isUnique;

    // Apply type inference
    const typeResult = this.typeInference.inferDatabaseType(
      fieldInfo,
      fieldName
    );
    const nullable = this.typeInference.inferNullability(
      !!fieldInfo.isOptional
    );
    const primaryKey = this.typeInference.inferPrimaryKey(fieldName);
    const unique = this.typeInference.inferUniqueConstraint(
      fieldName,
      hasExplicitUnique
    );

    // Analyze relationships
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
            referencedField: getPrimaryKeyField(),
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
   * Validate field metadata for common errors
   */
  private validateFieldMetadata(classInfo: EntityMetadata): void {
    for (const [fieldName, fieldInfo] of Object.entries(classInfo.fields)) {
      // Validate primary key field uses @uuid()
      if (
        fieldName === getPrimaryKeyField() &&
        fieldInfo.format !== FieldFormat.Uuid
      ) {
        const formatStr = fieldInfo.format
          ? `'${fieldInfo.format}'`
          : 'no format';
        this.errorCollector.addError({
          entity: classInfo.name,
          field: fieldName,
          message: `Primary key field '${fieldName}' must use @uuid() decorator, but has ${formatStr}`,
          fix: `Change @${fieldInfo.format || 'text'}() to @uuid() on the '${fieldName}' field`,
        });
      }

      // Validate text field options
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

        // Dialect-specific max string length validation.
        //   MSSQL NVARCHAR(n) is capped at 4000.
        //   Fabric MSSQL VARCHAR(n) is capped at 8000.
        //   PostgreSQL has no practical cap (maxStringLength === null).
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

        // MSSQL and the Fabric Warehouse / SQL Analytics dialects cannot
        // create unique indexes on *(N)VARCHAR(MAX)* columns; PostgreSQL
        // supports unique indexes on unbounded TEXT columns.
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

      // Validate int/decimal field options
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

      // Validate decimal precision/scale options
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

      // Validate set/enum field options
      if (fieldInfo.enum) {
        if (fieldInfo.enum.length === 0) {
          this.errorCollector.addError({
            entity: classInfo.name,
            field: fieldName,
            message: `Invalid set field: enum must have at least one value`,
            fix: `Provide at least one enum value, e.g., @set('option1', 'option2')`,
          });
        }

        // Check for duplicate values in enum (case-sensitive)
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
   * Validate relationships and check for foreign key conflicts
   */
  private validateRelationships(
    classInfo: EntityMetadata,
    fields: InferredField[]
  ): void {
    // Build a map of field names for quick lookup
    const fieldsByName = new Map<string, InferredField>();
    for (const field of fields) {
      fieldsByName.set(field.name, field);
    }

    // Check each relationship field for unresolved targets and FK conflicts
    for (const field of fields) {
      // A relationship here always references the target entity's primary key,
      // so explicit foreign-key columns are not supported.
      if (hasCustomForeignKey(field)) {
        const options = [
          field.sourceFields ? 'sourceFields' : undefined,
          field.targetFields ? 'targetFields' : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        this.errorCollector.addError({
          entity: classInfo.name,
          field: field.name,
          message: `Relationship '${field.name}' sets '${options}', which is not supported here; this relationship references the target entity's primary key.`,
          fix: `Remove '${options}' from the relationship on '${field.name}'.`,
        });
      }

      // Validate that relationship targets resolved successfully
      if (field.isRelationship && !field.foreignKey?.referencedEntity) {
        this.errorCollector.addError({
          entity: classInfo.name,
          field: field.name,
          message: `Relationship '${field.name}' could not resolve its target entity`,
          fix: `Ensure the target class exists, is imported correctly, and is passed to the schema array`,
        });
      }

      // A required (non-nullable) self-referencing @one relationship is
      // unsatisfiable: its foreign key column lives on the same table it
      // points at, so the very first row would need a parent that does not
      // exist yet. Fail fast and require the relationship to be optional.
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
        const fkColumnName = field.generatedForeignKeyColumn;

        // Check if the generated FK would conflict with field type expectations
        // Note: it is valid for a user to explicitly define the FK column field,
        // so we only flag a conflict when the type is wrong.
        const existingField = fieldsByName.get(fkColumnName);
        if (existingField && existingField.originalFieldMetadata) {
          const existingFormat = existingField.originalFieldMetadata.format;
          if (existingFormat !== FieldFormat.Uuid) {
            const formatStr: string = existingFormat;

            this.errorCollector.addError({
              entity: classInfo.name,
              field: field.name,
              message: `Foreign key type conflict: relationship '${field.name}' expects FK column '${fkColumnName}' to be UUID, but existing field has format '${formatStr}'`,
              fix: `Change the existing field '${fkColumnName}' to use @uuid() decorator`,
            });
          }
        }
      }
    }
  }
}
