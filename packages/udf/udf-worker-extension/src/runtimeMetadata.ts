import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

export const RUNTIME_METADATA_FILENAME = 'runtimemetadata.json';

/**
 * Schema version the CLI writes today.
 *
 * Bumped to `2.0` when `contextAudiences` became a guaranteed field. A `1.0`
 * file predates it, and since the worker no longer parses source it has no
 * way to recover audiences from such a file — connections would silently
 * resolve to none. The minimum check below rejects it outright instead.
 */
export const RUNTIME_METADATA_SCHEMA_VERSION = '2.0';

/**
 * Oldest schema this worker can run against. Metadata is accepted when its
 * major matches this and its minor is greater than or equal to it.
 *
 * A differing major is rejected outright — major means incompatible — so a
 * newer CLI paired with an older worker only loads across minor bumps, where
 * the closed key allowlists below decide whether its added fields are
 * actually understood.
 */
export const MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION = '2.0';

export interface RuntimeDelegateParameterMetadata {
  name: string;
  type?: string;
  optional: boolean;
  hasDefault: boolean;
  position: number;
  isFabricParameter: boolean;
  fabricParameterType?: string;
}

export interface RuntimeFunctionMetadata {
  functionName: string;
  delegateParameters: RuntimeDelegateParameterMetadata[];
  /**
   * Audiences declared on the handler's `RayfinContext` annotation, resolved
   * by the CLI's type checker at build time (e.g. `["ADO", "Sql"]`).
   *
   * Guaranteed present from schema `2.0` onward — always written, `[]` when
   * the handler declares none. It stays optional on the type only because
   * `RuntimeFunctionMetadata` is also the shape the CLI builds up before
   * serializing; a `1.0` file that omits it is rejected by the version gate,
   * because the worker no longer has a source-parsing path to recover from.
   */
  contextAudiences?: string[];
}

export interface RuntimeMetadataFile {
  /**
   * Dotted `major.minor` string. Read back as a plain `string` rather than
   * the current constant: the worker accepts any version at or above
   * {@link MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION}, including future ones.
   */
  schemaVersion: string;
  functions: RuntimeFunctionMetadata[];
}

export type RuntimeMetadataValidationResult =
  | { status: 'valid'; metadata: RuntimeMetadataFile }
  | { status: 'invalid'; message: string }
  | { status: 'unsupported-version'; version: string };

export type RuntimeMetadataLoadResult =
  | RuntimeMetadataValidationResult
  | { status: 'missing' };

const ROOT_KEYS = new Set(['schemaVersion', 'functions']);
const FUNCTION_KEYS = new Set([
  'functionName',
  'delegateParameters',
  'contextAudiences',
]);
const PARAMETER_KEYS = new Set([
  'name',
  'type',
  'optional',
  'hasDefault',
  'position',
  'isFabricParameter',
  'fabricParameterType',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function invalid(message: string): RuntimeMetadataValidationResult {
  return { status: 'invalid', message };
}

/**
 * Parses a dotted `major.minor` version into a comparable tuple.
 *
 * Returns `undefined` for anything that is not two non-negative integers, so
 * a malformed value is reported as unsupported rather than silently ordering
 * as `0.0` and passing a minimum of `0.0`.
 */
function parseSchemaVersion(
  version: string
): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * True when `version` is compatible with `minimum`.
 *
 * The major must match exactly: a major bump marks an incompatible schema, so
 * a `3.0` file is not something a `2.x` worker can interpret even though it
 * sorts higher. Within a major, a newer minor is accepted — minors are
 * additive, and the closed key allowlists below are what decide whether the
 * added fields are actually understood.
 *
 * Minors compare numerically. String comparison would be wrong here:
 * `'2.15' < '2.9'` lexicographically.
 */
function isCompatibleSchemaVersion(version: string, minimum: string): boolean {
  const actual = parseSchemaVersion(version);
  const floor = parseSchemaVersion(minimum);
  if (!actual || !floor) return false;
  if (actual.major !== floor.major) return false;
  return actual.minor >= floor.minor;
}

export function resolveRuntimeMetadataPath(srcRoot: string): string {
  return join(dirname(resolve(srcRoot)), RUNTIME_METADATA_FILENAME);
}

export function loadRuntimeMetadata(
  metadataPath: string
): RuntimeMetadataLoadResult {
  let serialized: string;
  try {
    serialized = readFileSync(metadataPath, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { status: 'missing' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('Runtime metadata must contain valid JSON.');
  }

  return validateRuntimeMetadata(parsed);
}

export function validateRuntimeMetadata(
  value: unknown
): RuntimeMetadataValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ROOT_KEYS)) {
    return invalid(
      'Runtime metadata must be an object with known fields only.'
    );
  }

  if (typeof value.schemaVersion !== 'string') {
    return invalid('Runtime metadata schemaVersion must be a string.');
  }
  if (
    !isCompatibleSchemaVersion(
      value.schemaVersion,
      MINIMUM_RUNTIME_METADATA_SCHEMA_VERSION
    )
  ) {
    return {
      status: 'unsupported-version',
      version: value.schemaVersion,
    };
  }
  if (!Array.isArray(value.functions)) {
    return invalid('Runtime metadata functions must be an array.');
  }

  const functionNames = new Set<string>();
  const functions: RuntimeFunctionMetadata[] = [];

  for (const [functionIndex, candidateFunction] of value.functions.entries()) {
    const functionPath = `functions[${functionIndex}]`;
    if (
      !isRecord(candidateFunction) ||
      !hasOnlyKeys(candidateFunction, FUNCTION_KEYS)
    ) {
      return invalid(`${functionPath} must contain known fields only.`);
    }
    if (
      typeof candidateFunction.functionName !== 'string' ||
      candidateFunction.functionName.trim().length === 0
    ) {
      return invalid(
        `${functionPath}.functionName must be a non-empty string.`
      );
    }
    if (functionNames.has(candidateFunction.functionName)) {
      return invalid(
        `${functionPath}.functionName duplicates '${candidateFunction.functionName}'.`
      );
    }
    if (!Array.isArray(candidateFunction.delegateParameters)) {
      return invalid(`${functionPath}.delegateParameters must be an array.`);
    }
    const { contextAudiences } = candidateFunction;
    if (
      contextAudiences !== undefined &&
      (!Array.isArray(contextAudiences) ||
        !contextAudiences.every(
          (audience) => typeof audience === 'string' && audience.length > 0
        ))
    ) {
      return invalid(
        `${functionPath}.contextAudiences must be an array of non-empty strings.`
      );
    }

    functionNames.add(candidateFunction.functionName);
    const delegateParameters: RuntimeDelegateParameterMetadata[] = [];

    for (const [
      parameterIndex,
      candidateParameter,
    ] of candidateFunction.delegateParameters.entries()) {
      const parameterPath = `${functionPath}.delegateParameters[${parameterIndex}]`;
      if (
        !isRecord(candidateParameter) ||
        !hasOnlyKeys(candidateParameter, PARAMETER_KEYS)
      ) {
        return invalid(`${parameterPath} must contain known fields only.`);
      }
      if (
        typeof candidateParameter.name !== 'string' ||
        candidateParameter.name.length === 0
      ) {
        return invalid(`${parameterPath}.name must be a non-empty string.`);
      }
      if (
        candidateParameter.type !== undefined &&
        (typeof candidateParameter.type !== 'string' ||
          candidateParameter.type.length === 0)
      ) {
        return invalid(`${parameterPath}.type must be a non-empty string.`);
      }
      if (typeof candidateParameter.optional !== 'boolean') {
        return invalid(`${parameterPath}.optional must be a boolean.`);
      }
      if (typeof candidateParameter.hasDefault !== 'boolean') {
        return invalid(`${parameterPath}.hasDefault must be a boolean.`);
      }
      if (
        !Number.isInteger(candidateParameter.position) ||
        candidateParameter.position !== parameterIndex
      ) {
        return invalid(
          `${parameterPath}.position must match its zero-based array position.`
        );
      }
      if (typeof candidateParameter.isFabricParameter !== 'boolean') {
        return invalid(`${parameterPath}.isFabricParameter must be a boolean.`);
      }
      if (
        candidateParameter.fabricParameterType !== undefined &&
        (typeof candidateParameter.fabricParameterType !== 'string' ||
          candidateParameter.fabricParameterType.length === 0)
      ) {
        return invalid(
          `${parameterPath}.fabricParameterType must be a non-empty string.`
        );
      }
      if (
        !candidateParameter.isFabricParameter &&
        candidateParameter.fabricParameterType !== undefined
      ) {
        return invalid(
          `${parameterPath}.fabricParameterType requires isFabricParameter to be true.`
        );
      }
      if (
        candidateParameter.isFabricParameter &&
        candidateParameter.type !== undefined &&
        candidateParameter.fabricParameterType !== candidateParameter.type
      ) {
        return invalid(
          `${parameterPath}.fabricParameterType must match type when type is present.`
        );
      }

      const parameter: RuntimeDelegateParameterMetadata = {
        name: candidateParameter.name,
        optional: candidateParameter.optional,
        hasDefault: candidateParameter.hasDefault,
        position: candidateParameter.position,
        isFabricParameter: candidateParameter.isFabricParameter,
      };
      if (candidateParameter.type !== undefined) {
        parameter.type = candidateParameter.type;
      }
      if (candidateParameter.fabricParameterType !== undefined) {
        parameter.fabricParameterType = candidateParameter.fabricParameterType;
      }
      delegateParameters.push(parameter);
    }

    const functionMetadata: RuntimeFunctionMetadata = {
      functionName: candidateFunction.functionName,
      delegateParameters,
    };
    if (contextAudiences !== undefined) {
      functionMetadata.contextAudiences = [...(contextAudiences as string[])];
    }
    functions.push(functionMetadata);
  }

  return {
    status: 'valid',
    metadata: {
      schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
      functions,
    },
  };
}
