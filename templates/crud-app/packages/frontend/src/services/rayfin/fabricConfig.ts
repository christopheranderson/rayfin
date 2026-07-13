import type { FabricAuthOptions } from '@microsoft/rayfin-auth-provider-fabric';
import type { FabricProxyOptions } from '@workspace-todo-app/local-dev';

/**
 * Fabric auth config for the in-app (production / WebView) login flow.
 * Returns `null` when the app hasn't been wired to a Fabric workspace yet
 * (i.e. before `npx rayfin up`), which the UI uses to show a "not configured"
 * affordance instead of a broken sign-in button.
 */
export function getFabricOptions(): FabricAuthOptions | null {
  const workspaceId = import.meta.env.VITE_FABRIC_WORKSPACE_ID;
  const projectId = import.meta.env.VITE_FABRIC_ITEM_ID;
  const fabricPortalUrl = import.meta.env.VITE_FABRIC_PORTAL_URL;
  if (!workspaceId || !projectId || !fabricPortalUrl) return null;
  return {
    workspaceId,
    projectId,
    fabricPortalUrl,
    returnOrigin: window.location.origin,
  };
}

/**
 * The same Fabric config shaped for the local dev-server auth proxy. The
 * proxy's bridge falls back to these same `VITE_*` vars, but passing them
 * through keeps the system-browser login config-driven from the app side.
 */
export function getFabricProxyOptions(): FabricProxyOptions {
  return {
    workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID,
    projectId: import.meta.env.VITE_FABRIC_ITEM_ID,
    portalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL,
    publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
  };
}
