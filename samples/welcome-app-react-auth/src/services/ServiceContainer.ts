import { IAuthService } from './interfaces/IAuthService';
import { ITimestampService } from './interfaces/ITimestampService';
import { RayfinAuthService } from './rayfin/RayfinAuthService';
import { RayfinClientService } from './rayfin/RayfinClientService';
import { RayfinTimestampService } from './rayfin/RayfinTimestampService';

/**
 * Service container that manages all application services
 * This implementation is Rayfin-only (no mock mode)
 */
export class ServiceContainer {
  private static instance: ServiceContainer | null = null;

  public readonly authService: IAuthService;
  public readonly timestampService: ITimestampService;

  private constructor(
    authService: IAuthService,
    timestampService: ITimestampService
  ) {
    this.authService = authService;
    this.timestampService = timestampService;
  }

  /**
   * Create and initialize the service container
   */
  static create(): ServiceContainer {
    if (!ServiceContainer.instance) {
      // Get configuration from environment variables
      const apiUrl =
        import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168';
      const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

      if (!publishableKey) {
        throw new Error(
          'VITE_RAYFIN_PUBLISHABLE_KEY environment variable is required'
        );
      }

      console.log('🔧 Initializing Rayfin services with API URL:', apiUrl);

      // Get optional project ID from environment variables (set by rayfin up)
      const projectId = import.meta.env.VITE_FABRIC_ITEM_ID;

      const rayfinClientService = RayfinClientService.getInstance();
      rayfinClientService.initialize(
        apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
        publishableKey
      );

      // Build auth service with capabilities based on environment
      const isLocalEnvironment =
        new URL(apiUrl).hostname === 'localhost' ||
        new URL(apiUrl).hostname === '127.0.0.1';

      const workspaceId = import.meta.env.VITE_FABRIC_WORKSPACE_ID;
      const fabricPortalUrl = import.meta.env.VITE_FABRIC_PORTAL_URL;
      const hasFabricConfig = !!(workspaceId && projectId && fabricPortalUrl);

      const authBuilder = RayfinAuthService.builder();

      if (isLocalEnvironment) {
        authBuilder.withUsernameAuth();
      }

      if (hasFabricConfig) {
        authBuilder.withFabricAuth({
          workspaceId,
          projectId,
          fabricPortalUrl,
        });
      }

      // Create service instances
      ServiceContainer.instance = new ServiceContainer(
        authBuilder.build(),
        new RayfinTimestampService()
      );

      console.log('✅ Rayfin services initialized successfully');
    }

    return ServiceContainer.instance;
  }

  /**
   * Get the singleton instance (throws if not created)
   */
  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      throw new Error('ServiceContainer not initialized. Call create() first.');
    }
    return ServiceContainer.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static reset(): void {
    ServiceContainer.instance = null;
    RayfinClientService.reset();
  }
}
