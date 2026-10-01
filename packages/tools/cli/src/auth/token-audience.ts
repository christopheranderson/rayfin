/**
 * Audience inspection for bearer tokens.
 *
 * An ambient `RAYFIN_TOKEN` is passed through verbatim: `ensureAuthenticated`
 * returns it without consulting the scopes the caller asked for, because there
 * is no exchange to perform. That is the right behaviour for a supplied token,
 * but it means a command that needs one audience can be handed a token minted
 * for another — a clean-room launcher that exports a single Fabric-audience
 * token satisfies every command's *request* while satisfying only some of their
 * *requirements*. The mismatch then surfaces at the far end as a 401 from the
 * data plane and gets read as a workspace or model permission problem.
 *
 * These helpers let a command check locally, before it spends a round trip.
 *
 * **No function here accepts or returns token material beyond the `aud` claim**,
 * which names a resource and is not a credential. Callers must not put the
 * token itself in an error, a log, or telemetry.
 */

/**
 * Read the `aud` claim from a bearer token or `Authorization` header value.
 *
 * Returns `undefined` for an opaque or malformed token rather than throwing,
 * so a caller can decide whether "cannot verify" should be fatal. Only the
 * payload segment is decoded; the signature is neither read nor validated —
 * this is a local sanity check, not authentication.
 *
 * @param tokenOrHeader - Raw JWT, or an `Authorization` header value.
 * @returns The audience, or `undefined` when it cannot be read.
 */
export function readTokenAudience(
  tokenOrHeader: string | undefined
): string | undefined {
  if (!tokenOrHeader) return undefined;

  const token = tokenOrHeader.replace(/^bearer\s+/iu, '').trim();
  const payload = token.split('.')[1];
  if (!payload) return undefined;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      aud?: unknown;
    };
    return typeof claims.aud === 'string' && claims.aud.length > 0
      ? claims.aud
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive the audience a scope requests.
 *
 * Scopes are built as `<resource>/.default`, so the resource is the audience.
 * Deriving it rather than hard-coding a constant keeps the guard correct when
 * `RAYFIN_FABRIC_SCOPE` points at a non-production ring.
 *
 * @param scope - An OAuth scope, e.g. `https://…/powerbi/api/.default`.
 * @returns The audience the scope targets.
 */
export function audienceFromScope(scope: string): string {
  return normalizeAudience(scope.replace(/\/\.default$/u, ''));
}

/** Trailing slashes are not significant in an audience URI. */
function normalizeAudience(audience: string): string {
  return audience.replace(/\/+$/u, '');
}

/**
 * Whether a token's audience satisfies a required one.
 *
 * Compares only after normalizing trailing slashes; no other leniency, because
 * a near-miss audience is still the wrong resource.
 */
export function audienceMatches(actual: string, expected: string): boolean {
  return normalizeAudience(actual) === normalizeAudience(expected);
}
