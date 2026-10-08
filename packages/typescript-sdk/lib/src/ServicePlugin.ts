import { ApiClient } from './ApiClient.js';

/**
 * (Experimental) Base class for creating custom service plugins.
 * @alpha
 * @internal
 */
export abstract class ServicePlugin {
  protected apiClient: ApiClient;
  constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }
}

/**
 * (Experimental) Type for a Factory method that creates a service plugin instance.
 * @alpha
 * @internal
 */
export type ServicePluginFactory<T> = (apiClient: ApiClient) => T;

/**
 * (Experimental) Type for a mapping of service plugin factories.
 * @alpha
 * @internal
 */
export type TServiceClasses<TServices extends Record<string, object>> = {
  [K in keyof TServices]: ServicePluginFactory<TServices[K]>;
};
