export const MULTIPLE_SQL_RESULT_SETS_MESSAGE =
  'Multiple SQL result sets are not supported. Submit a single SELECT or WITH query.';

export const MULTIPLE_SQL_RESULT_SETS_RECOVERY =
  'Submit a query that produces exactly one result set.';

export class MultipleSqlResultSetsError extends Error {
  override readonly name = 'MultipleSqlResultSetsError';

  constructor() {
    super(MULTIPLE_SQL_RESULT_SETS_MESSAGE);
  }
}
