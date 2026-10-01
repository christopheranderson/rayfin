/**
 * Get Rayfin configuration from environment
 */
export function getRayfinConfig() {
  return {
    baseUrl: import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168',
    publishableKey:
      import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY || 'default-key',
  };
}
