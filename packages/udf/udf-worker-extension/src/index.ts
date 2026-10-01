/**
 * Microsoft Fabric User Data Functions — TypeScript Extension
 * Public API surface.
 */

export { UserDataFunctions } from './userDataFunctions.js';
export { Connection, AudienceType } from './types/connection.js';
export type {
  AnyConnection,
  AudiencesOf,
  ConnectionOptions,
  AliasConnectionOptions,
  GenericConnectionOptions,
} from './types/connection.js';
export { FabricItem } from './types/fabricItem.js';
export { RayfinContext } from './types/rayfinContext.js';
export type {
  RayfinSecretRegistry,
  RegisteredSecretNames,
} from './types/secretsRegistry.js';

export {
  UDFExceptionCodes,
  type UDFExceptionCode,
  UserDataFunctionError,
  UserDataFunctionInternalError,
  UserDataFunctionInvalidInputError,
  UserDataFunctionMissingInputError,
  UserThrownError,
} from './errors/udfErrors.js';
