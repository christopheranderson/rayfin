import type { IAuthService } from './interfaces/IAuthService';
import type { INoteService } from './interfaces/INoteService';
import type { INotebookService } from './interfaces/INotebookService';
import { RayfinAuthService } from './rayfin/RayfinAuthService';
import { RayfinClientService } from './rayfin/RayfinClientService';
import { RayfinNoteService } from './rayfin/RayfinNoteService';
import { RayfinNotebookService } from './rayfin/RayfinNotebookService';

/**
 * Service container for dependency injection
 * Provides Rayfin-backed services for data and authentication
 */
export class ServiceContainer {
  private constructor(
    public readonly auth: IAuthService,
    public readonly notes: INoteService,
    public readonly notebooks: INotebookService
  ) {}

  /**
   * Create a service container with Rayfin services
   */
  static create(): ServiceContainer {
    // Get API URL from environment variables with fallback
    const apiUrl =
      import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168';
    console.log('🔧 Initializing Rayfin services with API URL:', apiUrl);

    // Get publishable key from environment variables
    const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error(
        'VITE_RAYFIN_PUBLISHABLE_KEY environment variable is required'
      );
    }

    const rayfinClientService = RayfinClientService.getInstance();
    rayfinClientService.initialize(
      apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
      publishableKey
    );

    const auth = new RayfinAuthService();
    const notes = new RayfinNoteService();
    const notebooks = new RayfinNotebookService();

    return new ServiceContainer(auth, notes, notebooks);
  }
}
