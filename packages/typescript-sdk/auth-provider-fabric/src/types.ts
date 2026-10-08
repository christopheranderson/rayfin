/**
 * Options for initiating Fabric brokered authentication.
 */
export interface FabricAuthOptions {
  /** The Fabric workspace ID. */
  workspaceId: string;
  /** The Fabric project/app ID (artifact ID). */
  projectId: string;
  /**
   * The Fabric Portal URL, including any existing path and query parameters.
   * The SDK appends `/groups/{workspaceId}/appbackends/{projectId}` to the
   * existing path and appends PKCE query parameters, preserving everything
   * already present in the URL.
   *
   * Examples:
   * - Production: `https://app.fabric.microsoft.com`
   * - With path: `https://app.fabric.microsoft.com/some/portal/path`
   * - Dev/test: `https://powerbi-df.analysis-df.windows.net?debug.useLocalManifests=1&experience=power-bi`
   */
  fabricPortalUrl: string;
  /**
   * The origin of the SPA that initiated the Fabric auth flow.
   * Used as the `targetOrigin` for `postMessage` delivery of the handoff code.
   * Must be a bare origin string (e.g., `https://myapp.com`), not a full URL with path.
   */
  returnOrigin: string;
  /**
   * Full redirect callback URL for old Fabric Portal deployments that haven't
   * adopted postMessage yet. When provided, this URL is sent as the `callbackUrl`
   * query parameter so the old Portal can redirect back with the handoff code.
   *
   * Defaults to `${returnOrigin}/auth/callback` when omitted.
   *
   * @deprecated Backward-compat only — will be removed once postMessage rollout is complete.
   */
  callbackUrl?: string;
  /**
   * When `true`, use embedded (iframe) authentication via postMessage instead
   * of the popup flow. The SDK also auto-detects embedded mode when
   * `?fabricEmbedded=true` is present in `window.location.search`.
   *
   * Set explicitly to override URL-based detection.
   */
  fabricEmbedded?: boolean;
}
