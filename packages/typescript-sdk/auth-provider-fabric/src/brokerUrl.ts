import type { FabricAuthOptions } from './types';

/** edog (dogfood) portal domain; unlike prod/daily/dxt it lacks SecureItemEmbed. */
const EDOG_PORTAL_DOMAIN_SUFFIX = '.analysis-df.windows.net';

/** `true` when `host` is the edog portal (`*.analysis-df.windows.net`). */
function isEdogPortal(host: string): boolean {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .endsWith(EDOG_PORTAL_DOMAIN_SUFFIX);
}

/**
 * Constructs the broker launch URL for the chromeless SecureItemEmbed view.
 *
 * Uses the SecureItemEmbed path so the popup renders without Fabric portal
 * chrome (navigation, ribbon).  Preserves any existing query parameters on
 * `fabricPortalUrl` and adds artifact identification + extensionPath.
 *
 * PKCE parameters are no longer included in the URL — they are delivered to
 * the extension via the postMessage challenge flow (`brokeredAuth.challenge`).
 *
 * edog lacks SecureItemEmbed, so it falls back to the full-portal deep-link.
 *
 * @param options - Auth options (workspace/project IDs, portal URL).
 * @returns Fully constructed broker URL.
 */
export function buildBrokerUrl(options: FabricAuthOptions): string {
  const portalUrl = new URL(options.fabricPortalUrl);
  const basePath = portalUrl.pathname.replace(/\/$/, '');

  // edog lacks SecureItemEmbed: use the full-portal deep-link. Query params
  // are preserved since only the path is rewritten.
  if (isEdogPortal(portalUrl.hostname)) {
    portalUrl.pathname =
      `${basePath}/groups/${encodeURIComponent(options.workspaceId)}` +
      `/appbackends/${encodeURIComponent(options.projectId)}/brokeredauth`;

    return portalUrl.toString();
  }

  // Chromeless SecureItemEmbed path (no Fabric navigation chrome).
  portalUrl.pathname = `${basePath}/secureItemEmbed`;

  // Artifact identification for SecureItemEmbed
  portalUrl.searchParams.set('workspaceId', options.workspaceId);
  portalUrl.searchParams.set('itemType', 'AppBackend');
  portalUrl.searchParams.set('itemId', options.projectId);

  // Route the extension to the BrokeredAuthPage; PKCE goes via postMessage.
  portalUrl.searchParams.set('extensionPath', '/brokeredauth');

  return portalUrl.toString();
}
