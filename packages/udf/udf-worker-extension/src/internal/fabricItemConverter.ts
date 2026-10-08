import { UserDataFunctionInternalError } from '../errors/udfErrors.js';
import { FabricItem, Endpoint } from '../types/fabricItem.js';

/**
 * Inspect the parsed endpoints and return the appropriate typed connection
 * object.
 *
 * @param aliasName - The alias for the data source.
 * @param endpoints - Parsed endpoints map with lowercase keys.
 * @returns A {@link FabricItem} (default). When we require typed FabricConnection objects, we can parse them here (Ex. SqlClient).
 */
function parseType(
  aliasName: string,
  endpoints: Map<string, Endpoint>
): FabricItem {
  return new FabricItem(aliasName, endpoints);
}

/**
 * Decode a raw binding value from the host extension into a typed connection
 * object.
 *
 * @param rawBindingData - The value from `context.extraInputs.get(binding)`.
 * @returns A typed connection object from {@link parseType}.
 * @throws {@link UserDataFunctionInternalError} If the binding is missing, malformed,
 *   or the host reported an error via `ErrorMessage`.
 */
export function decode(rawBindingData: unknown): FabricItem {
  if (rawBindingData == null) {
    throw new UserDataFunctionInternalError(
      'Unable to load data successfully for fabric item'
    );
  }

  let parsedData: unknown;
  if (typeof rawBindingData === 'string') {
    try {
      parsedData = JSON.parse(rawBindingData);
    } catch {
      throw new UserDataFunctionInternalError(
        'Unable to load data successfully for fabric item'
      );
    }
  } else {
    parsedData = rawBindingData;
  }
  if (!parsedData || typeof parsedData !== 'object') {
    throw new UserDataFunctionInternalError(
      'Unable to load data successfully for fabric item'
    );
  }

  const bindingRecord = parsedData as Record<string, unknown>;

  const errorMessage =
    typeof bindingRecord['ErrorMessage'] === 'string'
      ? bindingRecord['ErrorMessage']
      : null;
  if (errorMessage) {
    throw new UserDataFunctionInternalError(
      'Unable to load data successfully for fabric item',
      { reason: errorMessage }
    );
  }

  const aliasName = bindingRecord['AliasName'];
  if (typeof aliasName !== 'string' || !aliasName) {
    throw new UserDataFunctionInternalError(
      "FabricItem binding is missing a valid 'AliasName'."
    );
  }

  const endpoints = new Map<string, Endpoint>();
  const rawEndpoints = bindingRecord['Endpoints'];

  if (
    rawEndpoints &&
    typeof rawEndpoints === 'object' &&
    !Array.isArray(rawEndpoints)
  ) {
    for (const [key, value] of Object.entries(
      rawEndpoints as Record<string, unknown>
    )) {
      if (value && typeof value === 'object') {
        const ep = value as Record<string, unknown>;
        endpoints.set(key.toLowerCase(), {
          connectionString:
            typeof ep['ConnectionString'] === 'string'
              ? ep['ConnectionString']
              : '',
          accessToken:
            typeof ep['AccessToken'] === 'string' ? ep['AccessToken'] : '',
        });
      }
    }
  }

  const result = parseType(aliasName, endpoints);
  return result;
}
