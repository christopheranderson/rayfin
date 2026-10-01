import { GraphQLEntityClient } from '../../graphql/GraphQLEntityClient';
import type {
  EntitySchema,
  CreateInput,
  UpdateInput,
  WhereUniqueInput,
} from '../../graphql/types';

/**
 * Extended GraphQL Entity Client for testing purposes.
 * Exposes protected mutation building methods to enable direct mutation string validation.
 * Uses actual production methods to ensure tests validate real implementation.
 */
export class TestableGraphQLEntityClient<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
> extends GraphQLEntityClient<TSchema, TEntity> {
  /**
   * Build create mutation string without executing it
   * @param input - The create input data
   * @returns The generated GraphQL create mutation string
   */
  public buildCreateMutation(input: CreateInput<TSchema[TEntity]>): string {
    return this.buildCreateMutationString(input);
  }

  /**
   * Build update mutation string without executing it
   * @param where - The where clause to identify the record
   * @param data - The update data
   * @returns The generated GraphQL update mutation string
   */
  public buildUpdateMutation(
    where: WhereUniqueInput<TSchema[TEntity]>,
    data: UpdateInput<TSchema[TEntity]>
  ): string {
    return this.buildUpdateMutationString(where, data);
  }

  /**
   * Build delete mutation string without executing it
   * @param where - The where clause to identify the record
   * @returns The generated GraphQL delete mutation string
   */
  public buildDeleteMutation(
    where: WhereUniqueInput<TSchema[TEntity]>
  ): string {
    return this.buildDeleteMutationString(where);
  }

  /**
   * Build the mutation input formatting for testing
   * @param data - The input data to format
   * @returns The formatted mutation input string
   */
  public formatMutationInputForTesting(data: any): string {
    return this.formatMutationInput(data);
  }

  /**
   * Get the default fields for testing
   * @param data - The input data to extract fields from
   * @returns The default fields string
   */
  public getDefaultFieldsForTesting(data: any): string {
    return this.getDefaultFields(data);
  }

  /**
   * Extract ID from where clause for testing
   * @param where - The where clause
   * @returns The extracted ID
   */
  public extractIdForTesting(where: WhereUniqueInput<TSchema[TEntity]>): any {
    return this.extractId(where);
  }
}
