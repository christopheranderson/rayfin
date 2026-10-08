import { UserDataFunctionInvalidInputError } from '../errors/udfErrors.js';

/**
 * Parsed function-parameter metadata used during runtime argument binding.
 *
 * @internal
 */
export interface ParamInfo {
  /** Parameter name from the user function signature. */
  name: string;
  /** Declared parameter type text from the parsed signature. */
  type?: string;
  /** Whether the parameter has a default initializer. */
  hasDefault: boolean;
}

/**
 * Attempt to convert/validate a JSON value to match the declared TypeScript type.
 *
 * @param value - Raw value from the invocation payload.
 * @param declaredType - Declared TypeScript type for the target parameter.
 * @param paramName - Target function parameter name.
 * @returns The converted value, or a `UserDataFunctionInvalidInputError` describing conversion failure.
 *
 * @internal
 */
export function tryConvert(
  value: unknown,
  declaredType: string,
  paramName: string
): unknown {
  const normalizedType = declaredType.trim();

  // If no type info / 'any' / 'unknown', pass through
  if (
    !normalizedType ||
    normalizedType === 'any' ||
    normalizedType === 'unknown'
  ) {
    return value;
  }

  // Handle array types: T[], Array<T>
  if (normalizedType.endsWith('[]') || normalizedType.startsWith('Array<')) {
    if (!Array.isArray(value)) {
      return new UserDataFunctionInvalidInputError(
        `Expected an array for parameter '${paramName}', got ${typeof value}`,
        {
          parameter_name: paramName,
          parameter_type: declaredType,
          parameter_value: String(value),
        }
      );
    }
    return value;
  }

  switch (normalizedType) {
    case 'string': {
      if (typeof value === 'string') return value;
      // Convert numbers/booleans to string
      if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
      return new UserDataFunctionInvalidInputError(
        `Expected a string for parameter '${paramName}', got ${typeof value}`,
        {
          parameter_name: paramName,
          parameter_type: declaredType,
          parameter_value: String(value),
        }
      );
    }

    case 'number': {
      if (typeof value === 'number') return value;
      // Convert numeric strings
      if (typeof value === 'string') {
        const num = Number(value);
        if (!Number.isNaN(num)) return num;
      }
      return new UserDataFunctionInvalidInputError(
        `Expected a number for parameter '${paramName}', got ${typeof value}`,
        {
          parameter_name: paramName,
          parameter_type: declaredType,
          parameter_value: String(value),
        }
      );
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value; // TODO, do we need to convert "true"/"false" strings to boolean?
      return new UserDataFunctionInvalidInputError(
        `Expected a boolean for parameter '${paramName}', got ${typeof value}`,
        {
          parameter_name: paramName,
          parameter_type: declaredType,
          parameter_value: String(value),
        }
      );
    }

    case 'object':
    case 'Record': {
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return value;
      return new UserDataFunctionInvalidInputError(
        `Expected an object for parameter '${paramName}', got ${Array.isArray(value) ? 'array' : typeof value}`,
        {
          parameter_name: paramName,
          parameter_type: declaredType,
          parameter_value: String(value),
        }
      );
    }

    default:
      // For unknown/custom types (interfaces, type aliases), pass through
      // as-is since we have no runtime conversion logic for them.
      return value;
  }
}
