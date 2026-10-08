import { HttpError } from '../utils/retry-utils.js';

/**
 * Why a data-source call failed, at the granularity a recovery hint needs.
 *
 * `permission` and `auth` are kept apart because they lead to different
 * actions: `permission` needs someone to grant access, `auth` needs the
 * caller to re-authenticate.
 *
 * `login` is deliberately neither. A TDS login rejection under Entra token
 * auth (`Login failed for user '<token-identified principal>'`) carries no
 * signal for which of the two it is, and the server does not report a usable
 * state to tell them apart. Callers reach it holding a token they just
 * acquired, so missing item access is the likelier cause — but not certain
 * enough to assert. `unknown` leaves the recovery hint to the calling command,
 * which knows what the user was trying to do.
 */
export type SqlAccessErrorCategory =
  | 'permission'
  | 'auth'
  | 'login'
  | 'unknown';

export interface ClassifiedSqlError {
  category: SqlAccessErrorCategory;
  /** Server message plus any TDS diagnostics, ready to print. */
  message: string;
}

/**
 * SQL Server error numbers indicating a permission denial, as opposed to
 * a missing object or a generic execution failure.
 */
const SQL_PERMISSION_DENIED_ERROR_NUMBERS: ReadonlySet<number> = new Set([
  229, // SELECT permission denied on object
  230, // SELECT permission denied on column
  262, // permission denied on database
  297, // login does not have permission to run in the current database
  300, // permission denied on object
  916, // server principal cannot access the database under the current security context
]);

/** `RequestError.number`/`ConnectionError.code` for login/auth failures. */
const SQL_LOGIN_FAILURE_ERROR_NUMBERS: ReadonlySet<number> = new Set([
  18456, 4060,
]);

const SQL_LOGIN_FAILURE_CODES: ReadonlySet<string> = new Set(['ELOGIN']);

interface TediousLikeError {
  message?: string;
  number?: number;
  code?: string;
  state?: number;
  class?: number;
  serverName?: string;
}

/** Closest thing to a RootActivityId available for TDS-level SQL errors. */
export function formatSqlErrorDiagnostics(err: {
  state?: number;
  class?: number;
  serverName?: string;
}): string {
  const parts: string[] = [];
  if (typeof err.state === 'number') {
    parts.push(`State: ${err.state}`);
  }
  if (typeof err.class === 'number') {
    parts.push(`Class: ${err.class}`);
  }
  if (err.serverName) {
    parts.push(`Server: ${err.serverName}`);
  }
  return parts.length > 0 ? `\n   ${parts.join(', ')}` : '';
}

/**
 * Classify a `tedious` error — or an {@link HttpError} from the Fabric
 * control plane — as a permission denial, an authentication failure, an
 * ambiguous login rejection, or none of those.
 *
 * Callers own the recovery wording so the hint can name the operation the
 * user actually ran; this only decides which kind of hint applies.
 */
export function classifySqlAccessError(error: unknown): ClassifiedSqlError {
  if (error instanceof HttpError) {
    const category: SqlAccessErrorCategory =
      error.statusCode === 403
        ? 'permission'
        : error.statusCode === 401
          ? 'auth'
          : 'unknown';
    return { category, message: error.message };
  }

  const err = (error ?? {}) as TediousLikeError;
  const message = err.message ?? String(error);
  const detail = `${message}${formatSqlErrorDiagnostics(err)}`;

  if (
    typeof err.number === 'number' &&
    SQL_PERMISSION_DENIED_ERROR_NUMBERS.has(err.number)
  ) {
    return { category: 'permission', message: detail };
  }

  if (
    (typeof err.number === 'number' &&
      SQL_LOGIN_FAILURE_ERROR_NUMBERS.has(err.number)) ||
    (typeof err.code === 'string' && SQL_LOGIN_FAILURE_CODES.has(err.code))
  ) {
    return { category: 'login', message: detail };
  }

  return { category: 'unknown', message: detail };
}
