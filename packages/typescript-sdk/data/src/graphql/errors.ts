/**
 * Thrown when an aggregation query (`groupBy`/`aggregate`) is executed against a
 * Data API Builder (DAB) endpoint that does not expose aggregation.
 *
 * This happens when the Rayfin host has not enabled GraphQL aggregation
 * (`runtime.graphql.enable-aggregation`) — for example when the service predates
 * the aggregation change. In that
 * case DAB omits `groupBy` from each entity's `<Entity>Connection` type and
 * rejects the query at schema-validation time with a message that wraps the
 * field and type names in backticks, for example:
 * The field `groupBy` does not exist on the type `<Entity>Connection`.
 *
 * Catch this error to detect a host that does not support aggregation and fall
 * back or surface guidance to the user.
 */
export class AggregationNotSupportedError extends Error {
  /** The raw GraphQL error message(s) returned by the server. */
  readonly graphQLError: string;

  /**
   * @param graphQLError - The underlying GraphQL error message(s) from the server.
   */
  constructor(graphQLError: string) {
    super(
      'GraphQL aggregation (groupBy/aggregate) is not enabled on this endpoint. ' +
        'It requires a Rayfin host with GraphQL aggregation enabled. ' +
        `Underlying GraphQL error: ${graphQLError}`
    );
    this.name = 'AggregationNotSupportedError';
    this.graphQLError = graphQLError;

    // Preserve the prototype chain across transpilation / older runtimes so
    // `instanceof AggregationNotSupportedError` works as expected.
    Object.setPrototypeOf(this, AggregationNotSupportedError.prototype);
  }
}

/**
 * Matches the DAB schema-validation error raised when `groupBy` is missing from
 * an entity's connection type (aggregation not enabled on the host). Hot Chocolate
 * (the Rayfin host's GraphQL engine) wraps the field name in backticks, while
 * other/older hosts may use quotes, so the delimiter is optional. The entity name
 * varies, so only the stable portion is matched.
 */
export const AGGREGATION_NOT_SUPPORTED_PATTERN =
  /field [`'"]?groupBy[`'"]? does not exist on the type/i;
