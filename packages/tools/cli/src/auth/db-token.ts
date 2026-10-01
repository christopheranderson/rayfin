/**
 * Acquisition-time policy for database-scoped tokens.
 *
 * Four paths need a Power BI–audience token: `connector inspect`,
 * `connector invoke`, schema discovery (`connector add` / `update`), and the
 * semantic-model access probe. Each one previously chose its own scope and
 * ran its own audience check — or, in the probe's case, ran none at all — so
 * they drifted: `invoke` inferred the environment from the Fabric host, while
 * the rest read `RAYFIN_FABRIC_SCOPE`. This module is the single place that
 * decides, so a path cannot silently disagree with its siblings.
 *
 * **Why not `RAYFIN_FABRIC_SCOPE`.** That variable is documented as "the OAuth
 * scope used when acquiring Fabric tokens" — it names the *Fabric* resource.
 * Using it for a database token asks Entra for a Fabric-audience token and
 * presents it to Power BI, which is the very mismatch the guard here exists to
 * catch. Worse, a guard that derived its expectation from the same variable
 * would compare the token against the wrong audience and pass, leaving the
 * check inert in exactly the non-production ring it was meant to protect.
 *
 * The audience is therefore derived from the Fabric ring in effect, with
 * {@link DB_TOKEN_SCOPE_ENV} as the explicit escape hatch for anything those
 * rules do not cover.
 */
import { isFabricHost } from '@microsoft/rayfin-tools-common/_internal';

import { getFabricSettings } from '../config/constants.js';

import { audienceMatches, readTokenAudience } from './token-audience.js';

/**
 * Power BI resource for production and every first-party Fabric ring.
 *
 * Prod, daily, dxt, and msit are separate deployments with their own
 * endpoints, but all authenticate against the public Power BI resource.
 */
export const POWER_BI_AUDIENCE_PROD =
  'https://analysis.windows.net/powerbi/api';

/** Power BI resource for pre-production rings (EDOG/PPE/DF) and INT proxies. */
export const POWER_BI_AUDIENCE_INT =
  'https://analysis.windows-int.net/powerbi/api';

/** Opt-out for environments the host rules do not describe. */
export const DB_TOKEN_SCOPE_ENV = 'RAYFIN_DB_TOKEN_SCOPE';

/** The scope to request and the `aud` claim the result must carry. */
export interface DbTokenTarget {
  /** `.default` scope to hand MSAL. */
  scopes: string[];
  /** Expected `aud` claim on the resulting access token. */
  audience: string;
}

/**
 * `true` when `fabricApiBaseUrl` points at a first-party Fabric ring, which
 * authenticates against the public Power BI resource.
 *
 * Pre-production rings, INT proxies, and any unrecognized or malformed origin
 * return `false` and fall back to the `-int` resource. Keeping unknown hosts
 * on `-int` is deliberate: an arbitrary reverse proxy should never be handed a
 * production-scoped Power BI token.
 */
function isProdAudienceFabricHost(fabricApiBaseUrl: string): boolean {
  try {
    return isFabricHost(new URL(fabricApiBaseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the database token target for the environment currently in effect.
 *
 * An explicit {@link DB_TOKEN_SCOPE_ENV} wins; otherwise the Power BI resource
 * is paired with the Fabric ring named by `fabricApiBaseUrl`, which
 * `RAYFIN_FABRIC_API_URL` and `--workspace-uri` can redirect.
 *
 * @param fabricApiBaseUrl - Fabric API base URL; defaults to the active settings.
 */
export function resolveDbTokenTarget(
  fabricApiBaseUrl: string = getFabricSettings().fabricApiBaseUrl
): DbTokenTarget {
  const override = process.env[DB_TOKEN_SCOPE_ENV];
  if (override && override.length > 0) {
    return {
      scopes: [override],
      audience: override.replace(/\/\.default$/u, '').replace(/\/+$/u, ''),
    };
  }

  const audience = isProdAudienceFabricHost(fabricApiBaseUrl)
    ? POWER_BI_AUDIENCE_PROD
    : POWER_BI_AUDIENCE_INT;
  return { audience, scopes: [`${audience}/.default`] };
}

/** Outcome of checking a token against a {@link DbTokenTarget}. */
export type DbTokenAudienceFinding =
  | { status: 'ok' }
  | { status: 'unreadable' }
  | { status: 'mismatch'; actual: string };

/**
 * Compare a token's `aud` claim against what the target requires.
 *
 * Reports rather than throws: callers differ in how a failure must surface —
 * `inspect` and `invoke` exit with a handled error, while schema discovery is
 * best-effort and returns a result — and they differ in whether an
 * unreadable token is fatal. Deciding here would force one policy on all.
 *
 * @param tokenOrHeader - Raw JWT or an `Authorization` header value.
 * @param target - The target the token was meant to satisfy.
 */
export function inspectDbTokenAudience(
  tokenOrHeader: string,
  target: DbTokenTarget
): DbTokenAudienceFinding {
  const actual = readTokenAudience(tokenOrHeader);
  if (!actual) return { status: 'unreadable' };
  if (!audienceMatches(actual, target.audience)) {
    return { status: 'mismatch', actual };
  }
  return { status: 'ok' };
}

/**
 * Standard explanation for a token that cannot be audience-checked.
 *
 * Shared so every path words the same failure the same way.
 */
export function unreadableAudienceMessage(target: DbTokenTarget): {
  summary: string;
  recovery: string;
} {
  return {
    summary:
      'RAYFIN_TOKEN could not be decoded as a JWT, so its audience cannot be verified.',
    recovery: `Set RAYFIN_TOKEN to an access token for ${target.audience}, or unset it and run \`rayfin login\`, then retry.`,
  };
}

/**
 * Standard recovery for an ambient token minted for the wrong resource.
 *
 * `rayfin login` is deliberately not offered: an ambient token is passed
 * through unchanged, so signing in again cannot replace it.
 */
export function ambientMismatchRecovery(target: DbTokenTarget): string {
  return `RAYFIN_TOKEN is passed through unchanged regardless of the scopes this command requests. Unset it, or set it to a token for ${target.audience}, then retry.`;
}
