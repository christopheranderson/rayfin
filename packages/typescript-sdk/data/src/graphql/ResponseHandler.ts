import { deserializeDabResponse } from '../utils/serialization';

import type { PagedResult } from './types';

export class ResponseError extends Error {
  constructor(
    message: string,
    public readonly context: {
      response?: any;
      expectedStructure?: string;
    } = {}
  ) {
    super(message);
    this.name = 'ResponseError';
  }
}

/**
 * Utilities for unwrapping Data API Builder (DAB) GraphQL response envelopes.
 */
export class ResponseHandler {
  /**
   * Unwrap a DAB GraphQL response into its entity items.
   *
   * Accepts either a full response (`{ data: { <entity>: { items } } }`) or the
   * already-unwrapped data portion (`{ <entity>: { items } }`), applies DAB
   * deserialization, and returns either a flat array or a paginated result.
   *
   * @typeParam T - The entity type contained in the response.
   * @param response - The raw GraphQL response or its data portion.
   * @param entityPluralName - The DAB query field name (pluralized entity).
   * @param expectPagination - When `true`, return a {@link PagedResult} with
   *   `endCursor`/`hasNextPage`; otherwise return a flat array.
   * @returns The deserialized items, or a {@link PagedResult} when `expectPagination` is `true`.
   * @throws `ResponseError` - When the response structure is missing or malformed.
   */
  static unwrapGraphQLResponse<T>(
    response: any,
    entityPluralName: string,
    expectPagination = false
  ): T[] | PagedResult<T> {
    // Handle case where response is already the data portion
    let entityData;
    if (response?.data) {
      // Full GraphQL response format: { data: { entityName: { items: [...] } } }
      entityData = response.data[entityPluralName];
    } else if (response?.[entityPluralName]) {
      // Data portion only: { entityName: { items: [...] } }
      entityData = response[entityPluralName];
    } else {
      throw new ResponseError(
        'Invalid response structure: missing data field',
        {
          response,
          expectedStructure:
            '{ data: { [entityName]: { items: [...] } } } or { [entityName]: { items: [...] } }',
        }
      );
    }

    if (!entityData) {
      throw new ResponseError(`No data found for entity: ${entityPluralName}`, {
        response,
        expectedStructure: `{ data: { ${entityPluralName}: { items: [...] } } }`,
      });
    }

    // For single item queries (e.g., findById)
    if (!entityData.items && !Array.isArray(entityData)) {
      return deserializeDabResponse<T[]>(entityData) as T[];
    }

    // Validate DAB structure for list queries
    if (!Array.isArray(entityData.items)) {
      throw new ResponseError('Invalid DAB response: items is not an array', {
        response: entityData,
        expectedStructure:
          '{ items: [...], endCursor?: string, hasNextPage?: boolean }',
      });
    }

    if (expectPagination) {
      // DAB returns pagination fields at the top level of the entity response
      const paginatedResult = {
        items: entityData.items,
        // DAB only supports forward pagination (hasNextPage, endCursor)
        hasNextPage: entityData.hasNextPage ?? false,
        endCursor: entityData.endCursor ?? undefined,
      } as PagedResult<T>;

      // Apply DAB deserialization to the items
      return {
        ...paginatedResult,
        items: deserializeDabResponse<T[]>(paginatedResult.items),
      };
    }

    // Apply DAB deserialization to the items array
    return deserializeDabResponse<T[]>(entityData.items);
  }
}
