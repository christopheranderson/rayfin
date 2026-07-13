import { isLocalDev } from '@workspace-todo-app/local-dev';

import type { IAuthService } from './interfaces/IAuthService';
import type { IFunctionsService } from './interfaces/IFunctionsService';
import type { ITodoService } from './interfaces/ITodoService';
import { RayfinClientService } from './rayfin/RayfinClientService';
import { RayfinFabricAuthService } from './rayfin/RayfinFabricAuthService';
import { RayfinFunctionsService } from './rayfin/RayfinFunctionsService';
import { RayfinProxyAuthService } from './rayfin/RayfinProxyAuthService';
import { RayfinTodoService } from './rayfin/RayfinTodoService';

/**
 * Composition root. Constructs the RayfinClient and picks the auth strategy for
 * the current environment: the system-browser proxy flow in local dev, and the
 * in-app Fabric flow in a production build.
 */
export class ServiceContainer {
  private static instance: ServiceContainer | null = null;

  public readonly authService: IAuthService;
  public readonly todoService: ITodoService;
  public readonly functionsService: IFunctionsService;

  private constructor(
    authService: IAuthService,
    todoService: ITodoService,
    functionsService: IFunctionsService
  ) {
    this.authService = authService;
    this.todoService = todoService;
    this.functionsService = functionsService;
  }

  static create(): ServiceContainer {
    if (!ServiceContainer.instance) {
      RayfinClientService.getInstance().initialize();

      const authService: IAuthService = isLocalDev()
        ? new RayfinProxyAuthService()
        : new RayfinFabricAuthService();

      ServiceContainer.instance = new ServiceContainer(
        authService,
        new RayfinTodoService(),
        new RayfinFunctionsService()
      );
    }

    return ServiceContainer.instance;
  }

  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      throw new Error('ServiceContainer not initialized. Call create() first.');
    }
    return ServiceContainer.instance;
  }

  static reset(): void {
    ServiceContainer.instance = null;
    RayfinClientService.reset();
  }
}
