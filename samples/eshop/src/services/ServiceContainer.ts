import RayfinClient from '@microsoft/rayfin-client';

import { ZavaEshopSchema } from '../../rayfin/data/schema';

import type { IAddressService } from './interfaces/IAddressService';
import type { ICartService } from './interfaces/ICartService';
import type { ICategoryService } from './interfaces/ICategoryService';
import type { ICustomerService } from './interfaces/ICustomerService';
import type { IOrderService } from './interfaces/IOrderService';
import type { IProductService } from './interfaces/IProductService';
// Import Rayfin service implementations
import { RayfinAddressService } from './rayfin/RayfinAddressService';
import { RayfinCartService } from './rayfin/RayfinCartService';
import { RayfinCategoryService } from './rayfin/RayfinCategoryService';
import { initializeRayfinClient } from './rayfin/RayfinClientService';
import { RayfinCustomerService } from './rayfin/RayfinCustomerService';
import { RayfinOrderService } from './rayfin/RayfinOrderService';
import { RayfinProductService } from './rayfin/RayfinProductService';

/**
 * Service mode type - determines which implementation to use
 */
export type ServiceMode = 'mock' | 'rayfin';

/**
 * Service container interface - provides access to all application services
 */
export interface IServiceContainer {
  readonly customerService: ICustomerService;
  readonly categoryService: ICategoryService;
  readonly productService: IProductService;
  readonly cartService: ICartService;
  readonly orderService: IOrderService;
  readonly addressService: IAddressService;
}

let _serviceContainerInstance: IServiceContainer | undefined;
let _mode: ServiceMode = 'rayfin';

/**
 * Build the default request headers for the Rayfin client
 *
 * @returns The request headers record
 */
function buildRayfinHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: window.location.origin,
  };
  return headers;
}

/**
 * Global service container singleton
 * Provides centralized access to all application services
 */
export class ServiceContainer {
  static create(mode: ServiceMode = 'rayfin'): IServiceContainer {
    if (_serviceContainerInstance) {
      console.warn(
        'ServiceContainer already initialized. Returning existing instance.'
      );
      return _serviceContainerInstance;
    }
    console.log(`🔧 Initializing ServiceContainer in '${_mode}' mode`);
    // if (mode === 'mock') {
    //   // _serviceContainerInstance = new MockServiceContainer();
    // } else {
    const rayfinClient = new RayfinClient<ZavaEshopSchema>({
      baseUrl: import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168',
      publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY || '',
      headers: buildRayfinHeaders(),
    });
    initializeRayfinClient(rayfinClient);
    _serviceContainerInstance = new RayfinServiceContainer();
    // }
    return _serviceContainerInstance;
  }

  static getInstance(): IServiceContainer {
    if (_serviceContainerInstance === undefined) {
      return createServiceContainer();
    }
    return _serviceContainerInstance;
  }
}

export function setMode(mode: ServiceMode): void {
  if (_serviceContainerInstance) {
    console.warn('ServiceContainer already initialized. Cannot change mode.');
    return;
  }
  _mode = mode;
}

export function createServiceContainer(): IServiceContainer {
  if (_serviceContainerInstance) {
    console.warn(
      'ServiceContainer already initialized. Returning existing instance.'
    );
    return _serviceContainerInstance;
  }
  console.log(`🔧 Initializing ServiceContainer in '${_mode}' mode`);
  // if (_mode === 'mock') {
  //   // _serviceContainerInstance = new MockServiceContainer();
  // } else {
  const rayfinClient = new RayfinClient<ZavaEshopSchema>({
    baseUrl: import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168',
    publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY || '',
    headers: buildRayfinHeaders(),
  });
  initializeRayfinClient(rayfinClient);
  _serviceContainerInstance = new RayfinServiceContainer();
  // }
  return _serviceContainerInstance;
}

export function getServiceContainerInstance(): IServiceContainer {
  if (_serviceContainerInstance === undefined) {
    return createServiceContainer();
  }
  return _serviceContainerInstance;
}

// export class MockServiceContainer implements ServiceContainer {
//   public readonly categoryService = new MockCategoryService();
//   public readonly productService = new MockProductService(this.categoryService);

//   public readonly customerService = new MockCustomerService(getCurrentUser());
//   public readonly cartService = new MockCartService();
//   public readonly orderService = new MockOrderService();
//   public readonly addressService = new MockAddressService();
// }

export class RayfinServiceContainer implements IServiceContainer {
  public readonly customerService = new RayfinCustomerService();
  public readonly categoryService = new RayfinCategoryService();
  public readonly productService = new RayfinProductService();
  public readonly cartService = new RayfinCartService();
  public readonly orderService = new RayfinOrderService();
  public readonly addressService = new RayfinAddressService();
}
