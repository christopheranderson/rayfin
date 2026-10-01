import {
  ServicePlugin,
  TServiceClasses,
  ServicePluginFactory,
} from '@microsoft/rayfin-lib';

import RayfinClient, { RayfinClientConfig } from '../client';

export {
  ServicePlugin,
  type TServiceClasses,
  type ServicePluginFactory as ServicePluginClass,
};

/**
 * (Experimental) Extendable Rayfin Client supports adding custom services. Use `ExtendableRayfinClient.create` to instantiate.
 * @alpha
 * @internal
 */
export class ExtendableRayfinClient<
  TSchema extends Record<string, any> = Record<string, any>,
  TServices extends Record<string, object> = Record<string, object>,
> extends RayfinClient<TSchema> {
  private services: TServices = {} as TServices;

  protected constructor(
    config: RayfinClientConfig & { services?: TServiceClasses<TServices> }
  ) {
    super(config);
    const services = config.services || ({} as TServiceClasses<TServices>);
    this.services = Object.keys(services).reduce((acc: any, key) => {
      acc[key] = services[key](this.apiClient);
      return acc;
    }, {} as TServices);
    return this.createProxy() as this & TServices;
  }

  // Prioritize the client and then go to the services proxy
  private createProxy(): this & TServices {
    return new Proxy(this as any, {
      get: (target, prop) => {
        if (prop in target) {
          return target[prop];
        }
        if (target.services[prop]) {
          return target.services[prop];
        }
        return undefined;
      },

      has: (target, prop) => {
        if (prop in target) {
          return true;
        }
        if (target.services[prop]) {
          return true;
        }
        return false;
      },

      ownKeys: () => {
        return Object.keys(this.services);
      },

      getOwnPropertyDescriptor: (target, prop) => {
        if (prop in target) {
          return Object.getOwnPropertyDescriptor(target, prop);
        }
        if (target.services[prop]) {
          return Object.getOwnPropertyDescriptor(target.services, prop);
        }
        return undefined;
      },
    });
  }

  /**
   * (Experimental) Create an instance of ExtendableRayfinClient with custom services.
   * @alpha
   * @internal
   * @param config - The configuration for the Rayfin client.
   * @param services - The custom services to extend the client with.
   * @returns An instance of ExtendableRayfinClient with the specified services.
   */
  public static create<
    TSchema extends Record<string, any>,
    TServices extends Record<string, object>,
  >(
    config: RayfinClientConfig & { schema?: TSchema } & {
      services?: TServiceClasses<TServices>;
    }
  ): ExtendableRayfinClient<TSchema, TServices> & TServices {
    return new ExtendableRayfinClient(
      config
    ) as unknown as ExtendableRayfinClient<TSchema, TServices> & TServices;
  }
}
