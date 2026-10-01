import type { RayfinClient } from '@microsoft/rayfin-client';

import type { ZavaEshopSchema } from '../../../rayfin/data/schema';

/**
 * Singleton function to get the RayfinClient instance
 * This ensures we reuse the same client across all services
 */
let rayfinClientInstance: RayfinClient<ZavaEshopSchema> | null = null;

export function getRayfinClient(): RayfinClient<ZavaEshopSchema> {
  if (!rayfinClientInstance) {
    // This would normally be initialized in the main app setup
    // For now, we'll throw an error to indicate it needs to be set up
    throw new Error(
      'RayfinClient not initialized. Please initialize the client in your application setup.'
    );
  }
  return rayfinClientInstance;
}

/**
 * Initialize the RayfinClient instance
 * This should be called once during application startup
 */
export function initializeRayfinClient(
  client: RayfinClient<ZavaEshopSchema>
): void {
  rayfinClientInstance = client;
}

/**
 * Reset the RayfinClient instance (for testing)
 */
export function resetRayfinClient(): void {
  rayfinClientInstance = null;
}
