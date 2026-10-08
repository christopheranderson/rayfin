export {
  entity,
  role,
  authenticated,
  anonymous,
  text,
  uuid,
  int,
  decimal,
  email,
  boolean,
  set,
  date,
  one,
  many,
} from './decorators/decorators.js';
export type {
  BaseFieldOptions,
  TextFieldOptions,
  UUIDFieldOptions,
  IntFieldOptions,
  DecimalFieldOptions,
  BooleanFieldOptions,
  SetFieldOptions,
  DateFieldOptions,
  RelationshipFieldOptions,
  CustomKeyRelationshipFieldOptions,
} from './decorators/decorators.js';
export type {
  SimpleAction,
  FieldPermissions,
  DatabasePolicy,
  StoragePolicy,
  ActionPolicy,
  ComplexAction,
  PermissionAction,
  PermissionConfig,
  PolicyOptions,
  RoleDeclarationOptions,
  RoleDeclaration,
  ClaimName,
} from './options.js';
export * from './system-entities.js';
export * from './policy.js';

// The stable surface is curated by hand. See AGENTS.md ("Exports") before
// widening it or reverting this to a wildcard re-export.
export {
  RayfinEntity,
  RayfinEntityMarker,
  RayfinSource,
  RayfinPrimaryKey,
  isRayfinEntity,
  FieldFormat,
  getPrimaryKeyField,
  ScalarToStringTags,
  RelationshipTypes,
  isFieldMetadata,
  upsertFieldMetadata,
  upsertPermissions,
  getEntityMetadata,
} from './schema.js';
export type {
  PrimaryKeyField,
  IEntity,
  constructor,
  EntityClass,
  EntityInstance,
  FromEntityClass,
  ScalarMapping,
  Scalar,
  Scalars,
  ScalarTypes,
  EntityBase,
  FieldType,
  ScalarFieldType,
  ScalarValueType,
  EnumFieldType,
  EnumValueType,
  RelationFieldType,
  DefaultFieldType,
  FieldMetadata,
  EntityMetadata,
} from './schema.js';

export { toStandardSchema } from './standard-schema.js';
export type { RayfinStandardSchema } from './standard-schema.js';
export {
  getFieldConstraints,
  fieldMetadataToConstraints,
} from './standard-schema-shared.js';
export type {
  FieldConstraints,
  StringConstraints,
  NumberConstraints,
  EnumConstraints,
  BooleanConstraints,
  DateConstraints,
  RelationshipConstraints,
} from './standard-schema-shared.js';

// Re-exported so consumers don't need a direct dependency on
// @standard-schema/spec.
export type { StandardSchemaV1 } from '@standard-schema/spec';
