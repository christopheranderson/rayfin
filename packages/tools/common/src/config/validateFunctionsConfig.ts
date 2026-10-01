const APPLICATION_AUTH_HINT =
  'Set services.functions.auth.type to "application".';

function describeInvalidValue(value: unknown): string {
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'object' && value !== null) {
    return 'a mapping';
  }
  return `"${String(value)}"`;
}

export interface FunctionsConfigValidationError {
  /** Dotted path of the offending field in `rayfin.yml`. */
  field: string;
  message: string;
}

/**
 * Validate the `services.functions` block from rayfin.yml.
 *
 * Enabled Functions require explicit application authentication. Disabled
 * Functions may omit auth, but any supplied auth must also use application.
 * Enablement follows the truthiness checks used by execution and deployment.
 * Validation never defaults or rewrites the authored configuration.
 */
export function validateFunctionsConfig(
  functions: unknown
): FunctionsConfigValidationError[] {
  if (functions === undefined || functions === null) {
    return [];
  }

  // A scalar or sequence in place of the whole block would be silently treated
  // as "functions disabled" downstream. Reject it here so the Builder sees the
  // authoring mistake instead of a surprising no-op deploy.
  if (typeof functions !== 'object' || Array.isArray(functions)) {
    return [
      {
        field: 'services.functions',
        message:
          'Invalid services.functions: expected a mapping, but found ' +
          `${describeInvalidValue(functions)}. Set services.functions to a ` +
          'mapping, for example: { enabled: false }.',
      },
    ];
  }

  const { enabled, auth } = functions as {
    enabled?: unknown;
    auth?: unknown;
  };
  if (auth === undefined) {
    if (!enabled) {
      return [];
    }
    return [
      {
        field: 'services.functions.auth',
        message:
          'Invalid services.functions.auth: authentication is required when ' +
          `Functions are enabled. ${APPLICATION_AUTH_HINT}`,
      },
    ];
  }

  // The host deserializes `auth` into an object with a `type` member, so a
  // scalar or sequence would be rejected remotely at deploy time. Reject it
  // here instead, where the Builder can act on it.
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
    return [
      {
        field: 'services.functions.auth',
        message:
          'Invalid services.functions.auth: expected a mapping with a "type" ' +
          `field, but found ${describeInvalidValue(auth)}. ${APPLICATION_AUTH_HINT}`,
      },
    ];
  }

  const type = (auth as { type?: unknown }).type;
  if (type === 'application') {
    return [];
  }

  return [
    {
      field: 'services.functions.auth.type',
      message:
        (type === undefined
          ? 'Invalid services.functions.auth.type: a type is required. '
          : 'Invalid services.functions.auth.type: found ' +
            `${describeInvalidValue(type)}. Only application authentication is supported. `) +
        APPLICATION_AUTH_HINT,
    },
  ];
}
