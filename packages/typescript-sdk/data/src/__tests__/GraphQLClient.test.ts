import { ApiClient } from '@microsoft/rayfin-lib';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { GraphQLClient } from '../graphql/GraphQLClient';
import { AggregationNotSupportedError } from '../graphql/errors';

describe('GraphQLClient', () => {
  let client: GraphQLClient;
  let mockApiClient: ApiClient;

  beforeEach(() => {
    mockApiClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as any;

    client = new GraphQLClient(mockApiClient, '/data-api/graphql');
  });

  describe('request', () => {
    it('should execute a GraphQL query', async () => {
      const mockResponse = {
        data: {
          users: [
            { id: 1, name: 'User 1' },
            { id: 2, name: 'User 2' },
          ],
        },
      };

      // ApiClient returns the unwrapped data directly
      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query {
          users {
            id
            name
          }
        }
      `;

      const result = await client.request(query);

      expect(result).toEqual(mockResponse.data);
      expect(mockApiClient.post).toHaveBeenCalledWith('/data-api/graphql', {
        query: query,
        variables: undefined,
        operationName: undefined,
      });
    });

    it('should execute a GraphQL query with variables', async () => {
      const mockResponse = {
        data: {
          user: { id: 1, name: 'User 1' },
        },
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query GetUser($id: ID!) {
          user(id: $id) {
            id
            name
          }
        }
      `;
      const variables = { id: 1 };

      const result = await client.request(query, variables);

      expect(result).toEqual(mockResponse.data);
      expect(mockApiClient.post).toHaveBeenCalledWith('/data-api/graphql', {
        query: query,
        variables: variables,
        operationName: undefined,
      });
    });

    it('should execute a GraphQL mutation', async () => {
      const mockResponse = {
        data: {
          createUser: { id: 3, name: 'New User' },
        },
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const mutation = `
        mutation CreateUser($input: UserInput!) {
          createUser(input: $input) {
            id
            name
          }
        }
      `;
      const variables = { input: { name: 'New User' } };

      const result = await client.request(mutation, variables);

      expect(result).toEqual(mockResponse.data);
      expect(mockApiClient.post).toHaveBeenCalledWith('/data-api/graphql', {
        query: mutation,
        variables: variables,
        operationName: undefined,
      });
    });
  });

  describe('query', () => {
    it('should execute a GraphQL query using query method', async () => {
      const mockResponse = {
        data: {
          users: [{ id: 1, name: 'User 1' }],
        },
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query {
          users {
            id
            name
          }
        }
      `;

      const result = await client.query(query);

      expect(result).toEqual(mockResponse.data);
      expect(mockApiClient.post).toHaveBeenCalledWith('/data-api/graphql', {
        query: query,
        variables: undefined,
        operationName: undefined,
      });
    });

    it('should execute a GraphQL query with variables using query method', async () => {
      const mockResponse = {
        data: {
          user: { id: 1, name: 'User 1' },
        },
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query GetUser($id: ID!) {
          user(id: $id) {
            id
            name
          }
        }
      `;
      const variables = { id: 1 };

      const result = await client.query(query, variables);

      expect(result).toEqual(mockResponse.data);
      expect(mockApiClient.post).toHaveBeenCalledWith('/data-api/graphql', {
        query: query,
        variables: variables,
        operationName: undefined,
      });
    });
  });

  describe('mutation', () => {
    it('should execute a GraphQL mutation using mutation method', async () => {
      const mockResponse = {
        data: {
          createUser: { id: 3, name: 'New User' },
        },
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const mutation = `
        mutation CreateUser($input: UserInput!) {
          createUser(input: $input) {
            id
            name
          }
        }
      `;
      const variables = { input: { name: 'New User' } };

      const result = await client.mutation(mutation, variables);

      expect(result).toEqual(mockResponse.data);
      expect(mockApiClient.post).toHaveBeenCalledWith('/data-api/graphql', {
        query: mutation,
        variables: variables,
        operationName: undefined,
      });
    });
  });

  describe('error handling', () => {
    it('should handle GraphQL errors in response', async () => {
      const mockResponse = {
        data: null,
        errors: [{ message: 'Field "invalidField" not found' }],
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query {
          users {
            invalidField
          }
        }
      `;

      await expect(client.request(query)).rejects.toThrow(
        'GraphQL errors: Field "invalidField" not found'
      );
    });

    it('should handle network errors', async () => {
      const error = new Error('Network Error');
      (mockApiClient.post as any).mockRejectedValue(error);

      const query = `
        query {
          users {
            id
            name
          }
        }
      `;

      await expect(client.request(query)).rejects.toThrow('Network Error');
    });

    it('should handle multiple GraphQL errors', async () => {
      const mockResponse = {
        data: null,
        errors: [{ message: 'First error' }, { message: 'Second error' }],
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query {
          users {
            invalidField
          }
        }
      `;

      await expect(client.request(query)).rejects.toThrow(
        'GraphQL errors: First error, Second error'
      );
    });

    it('maps a disabled-aggregation DAB error to AggregationNotSupportedError', async () => {
      const mockResponse = {
        data: null,
        errors: [
          {
            message:
              "The field 'groupBy' does not exist on the type 'TodoConnection'.",
          },
        ],
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      const query = `
        query {
          todos {
            groupBy {
              aggregations {
                n: count(field: id)
              }
            }
          }
        }
      `;

      await expect(client.request(query)).rejects.toBeInstanceOf(
        AggregationNotSupportedError
      );
      await expect(client.request(query)).rejects.toThrow(
        /aggregation .* is not enabled on this endpoint/i
      );
    });

    it('preserves the raw DAB message on AggregationNotSupportedError', async () => {
      const rawMessage =
        "The field 'groupBy' does not exist on the type 'SaleConnection'.";
      const mockResponse = { data: null, errors: [{ message: rawMessage }] };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      await expect(
        client.request('query { sales { groupBy { } } }')
      ).rejects.toMatchObject({ graphQLError: rawMessage });
    });

    it('maps a backtick-wrapped disabled-aggregation DAB error to AggregationNotSupportedError', async () => {
      // Hot Chocolate (the Rayfin host) wraps field/type names in backticks.
      const mockResponse = {
        data: null,
        errors: [
          {
            message:
              'The field `groupBy` does not exist on the type `TodoConnection`.',
          },
        ],
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      await expect(
        client.request('query { todos { groupBy { } } }')
      ).rejects.toBeInstanceOf(AggregationNotSupportedError);
    });

    it('does not map unrelated missing-field errors to AggregationNotSupportedError', async () => {
      const mockResponse = {
        data: null,
        errors: [
          {
            message:
              "The field 'foo' does not exist on the type 'TodoConnection'.",
          },
        ],
      };

      (mockApiClient.post as any).mockResolvedValue(mockResponse);

      await expect(
        client.request('query { todos { foo } }')
      ).rejects.not.toBeInstanceOf(AggregationNotSupportedError);
    });
  });
});
