/**
 * Capacity and trial endpoints of the Fabric REST API.
 *
 * This manager depends only on the universal transport, so any host can reuse
 * the same endpoint construction and operation semantics.
 */
import { isTrialCapacity } from './capacity.js';
import type {
  FabricCapacity,
  FabricOperationStatus,
  TrialEligibility,
} from './capacity.js';
import type { FabricHttpClient } from './http-client.js';
import {
  collectPages,
  findInPages,
  resolveOperationPath,
} from './pagination.js';
import type { FabricPollableOperation } from './types.js';

export class CapacityManager {
  public constructor(
    private readonly transport: FabricHttpClient,
    private readonly baseUrl: string
  ) {}

  /** Return the first usable trial capacity without reading unnecessary pages. */
  public findTrial(): Promise<FabricCapacity | undefined> {
    return findInPages<FabricCapacity>(
      this.transport,
      this.baseUrl,
      '/capacities',
      (capacity) => isTrialCapacity(capacity)
    );
  }

  /** Return every capacity the principal can assign, following pagination. */
  public list(): Promise<FabricCapacity[]> {
    return collectPages<FabricCapacity>(
      this.transport,
      this.baseUrl,
      '/capacities'
    );
  }

  public get(capacityId: string): Promise<FabricCapacity> {
    return this.transport.request(
      `/capacities/${encodeURIComponent(capacityId)}`
    );
  }

  private static readonly TRIAL_ROUTE_PREFIX = '/__private/capacities';

  public checkTrialEligibility(): Promise<TrialEligibility> {
    return this.transport.request<TrialEligibility>(
      `${CapacityManager.TRIAL_ROUTE_PREFIX}/checkTrialEligibility`,
      'POST'
    );
  }

  public startTrial(): Promise<FabricPollableOperation> {
    return this.transport.startOperation(
      CapacityManager.TRIAL_ROUTE_PREFIX,
      'POST',
      { type: 'FabricTrialCapacity' }
    );
  }

  public async getOperationStatus(
    operationLocation: string,
    operationId?: string
  ): Promise<FabricOperationStatus> {
    const { data, retryAfterMs } =
      await this.transport.requestWithRetryAfter<FabricOperationStatus>(
        resolveOperationPath(operationLocation, this.baseUrl, operationId)
      );
    return retryAfterMs === undefined ? data : { ...data, retryAfterMs };
  }

  public getOperationResult<T>(operationId: string): Promise<T> {
    return this.transport.request(
      `/operations/${encodeURIComponent(operationId)}/result`
    );
  }
}
