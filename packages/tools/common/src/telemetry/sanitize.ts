/**
 * Field-level redaction and sanitization utilities for telemetry.
 *
 * These helpers ensure that no sensitive data (file paths, secrets,
 * parameter values, or verbose stack traces) leaks into telemetry
 * payloads.
 */

/** Maximum length for sanitized exception messages. */
const MAX_MESSAGE_LENGTH = 256;

/** Default maximum length for a custom telemetry property value. */
const DEFAULT_MAX_PROPERTY_VALUE_LENGTH = 256;

/** Pattern matching common file-system paths. */
const FILE_PATH_PATTERN =
  /(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|etc|usr|opt|mnt|private))[^\s'")\]}>]*/gi;

/**
 * Sanitize an Error for telemetry consumption.
 *
 * Returns a safe summary containing only the error name, constructor
 * type, and a truncated/redacted message. Stack traces are never
 * included.
 */
export function sanitizeException(error: Error): {
  name: string;
  type: string;
  message?: string;
} {
  const name = error.name || 'Error';
  const type = error.constructor?.name || 'Error';
  const raw = error.message || '';
  const cleaned = stripFilePaths(raw);
  const bounded = boundField(cleaned, MAX_MESSAGE_LENGTH);

  return {
    name,
    type,
    message: bounded || undefined,
  };
}

/**
 * Extract safe parameter names from a command-line argument array.
 *
 * Returns only the flag names (e.g. `--output`, `-v`) without their
 * associated values. Flags using `--key=value` syntax are truncated
 * at the `=` sign.
 */
export function extractSafeParamNames(args: string[]): string[] {
  return args
    .filter((arg) => arg.startsWith('-') && arg !== '-' && arg !== '--')
    .map((arg) => {
      const eqIndex = arg.indexOf('=');
      return eqIndex !== -1 ? arg.substring(0, eqIndex) : arg;
    });
}

/**
 * Truncate a string to the specified maximum length.
 */
export function boundField(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.substring(0, maxLength);
}

/** Redact filesystem paths and bound a custom telemetry property value. */
export function sanitizeTelemetryProperty(
  value: string,
  maxLength = DEFAULT_MAX_PROPERTY_VALUE_LENGTH
): string {
  return boundField(stripFilePaths(value), maxLength);
}

/**
 * Replace file-system paths in a string with a redaction placeholder.
 */
function stripFilePaths(value: string): string {
  return value.replace(FILE_PATH_PATTERN, '[path]');
}
