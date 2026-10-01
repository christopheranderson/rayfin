import { GraphQLQueryBuilder } from '../../graphql/GraphQLQueryBuilder';

/**
 * Extended GraphQL Query Builder for testing purposes.
 * Exposes protected query building methods to enable direct query string validation.
 * Uses actual production methods to ensure tests validate real implementation.
 */
export class TestableGraphQLQueryBuilder<
  TSchema extends Record<string, any>,
  TEntity extends keyof TSchema,
> extends GraphQLQueryBuilder<TSchema, TEntity> {
  /**
   * Expose the protected buildQuery method for testing
   * @returns The generated GraphQL query string
   */
  public buildQueryString(): string {
    return this.buildQuery();
  }

  /**
   * Expose the protected buildQueryWithPagination method for testing
   * @returns The generated GraphQL query string with pagination fields
   */
  public buildQueryStringWithPagination(): string {
    return this.buildQueryWithPagination();
  }
}
