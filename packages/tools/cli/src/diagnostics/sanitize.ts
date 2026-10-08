import { isAbsolute, parse, resolve } from 'node:path';

import type { DiagnosticEvent } from '@microsoft/rayfin-tools-common/_internal/adapters';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY_LENGTH = 50;
const MAX_STRING_LENGTH = 2_048;

const SENSITIVE_KEY_PATTERN =
  /authorization|proxy.?authorization|access.?token|refresh.?token|id.?token|bearer|cookie|session.?id|password|secret|connection.?string|private.?key|email|(^|[^a-z])oid([^a-z]|$)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_URL_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:access_token|token|sig|signature|key|secret|password)=)[^&#\s]+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
const PASSWORD_SEGMENT_PATTERN =
  /\b(Password|Pwd|AccountKey|SharedAccessKey)\s*=\s*[^;\s]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|etc|usr|opt|mnt|private|workspaces?))[^\s'")\]}>]*/gi;

export interface DiagnosticSanitizerOptions {
  projectRoot?: string;
  homeDir?: string;
}

/** Sanitize and bound an event before it reaches any diagnostic sink. */
export function sanitizeDiagnosticEvent(
  event: DiagnosticEvent,
  options: DiagnosticSanitizerOptions = {}
): DiagnosticEvent {
  const seen = new WeakSet<object>();
  return {
    area: sanitizeText(event.area, options),
    message: sanitizeText(event.message, options),
    data: event.data
      ? (sanitizeValue(event.data, options, seen, 0) as Record<string, unknown>)
      : undefined,
  };
}

function sanitizeValue(
  value: unknown,
  options: DiagnosticSanitizerOptions,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (typeof value === 'string') {
    return sanitizeText(value, options);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (depth >= MAX_DEPTH) {
    return '[MAX_DEPTH]';
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }

  seen.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: sanitizeText(value.name, options),
        message: sanitizeText(value.message, options),
        stack: value.stack ? sanitizeText(value.stack, options) : undefined,
      };
    }
    if (Array.isArray(value)) {
      const result = value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => sanitizeValue(item, options, seen, depth + 1));
      if (value.length > MAX_ARRAY_LENGTH) {
        result.push(`[TRUNCATED ${value.length - MAX_ARRAY_LENGTH} ITEMS]`);
      }
      return result;
    }

    const entries = Object.entries(value).slice(0, MAX_KEYS);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : sanitizeValue(item, options, seen, depth + 1);
    }
    if (Object.keys(value).length > MAX_KEYS) {
      result['__truncatedKeys'] = Object.keys(value).length - MAX_KEYS;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function redactTerminalText(value: string): string {
  let result = value.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  if (result.includes('://')) {
    result = result.replace(CREDENTIAL_URL_PATTERN, `$1${REDACTED}@`);
  }
  result = result
    .replace(SENSITIVE_QUERY_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => {
      return `${key}=${REDACTED}`;
    })
    .replace(PASSWORD_SEGMENT_PATTERN, (_match, key: string) => {
      return `${key}=${REDACTED}`;
    });
  return result.includes('@')
    ? result.replace(EMAIL_PATTERN, REDACTED)
    : result;
}

function sanitizeText(
  value: string,
  options: DiagnosticSanitizerOptions
): string {
  let result = redactTerminalText(value);
  result = replacePath(result, options.projectRoot, '.');
  result = replacePath(result, options.homeDir, '~');
  result = result.replace(ABSOLUTE_PATH_PATTERN, '[path]');
  return Array.from(result).slice(0, MAX_STRING_LENGTH).join('');
}

function replacePath(value: string, path: string | undefined, label: string) {
  if (!path || !isAbsolute(path)) {
    return value;
  }
  const normalizedPath = resolve(path);
  if (normalizedPath === parse(normalizedPath).root) {
    return value;
  }
  return value.replaceAll(normalizedPath, label);
}
