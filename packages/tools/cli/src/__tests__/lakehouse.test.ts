import { describe, it, expect, vi, beforeEach } from 'vitest';

import { LakehouseManager } from '../services/fabric/lakehouse.js';

// Mock the base client
vi.mock('../services/fabric/client.js', () => ({
  default: class MockFabricApiClient {
    protected accessToken: string;

    constructor(accessToken: string) {
      this.accessToken = accessToken;
    }

    protected async request<T>(
      _path: string,
      _method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
      _body?: any
    ): Promise<T> {
      // Mock implementation for testing
      return {} as T;
    }

    protected async pollOperationStatus<T>(
      _operationLocation: string,
      _initialRetryAfter = 30,
      _maxRetries = 30
    ): Promise<T> {
      // Mock implementation for testing
      return {} as T;
    }
  },
}));

describe('LakehouseManager', () => {
  let lakehouseManager: LakehouseManager;
  const mockToken = 'mock-token';

  beforeEach(() => {
    lakehouseManager = new LakehouseManager(mockToken);
  });

  describe('createLakehouse', () => {
    it('should create a lakehouse with valid parameters', async () => {
      const mockLakehouse = {
        id: 'test-id',
        displayName: 'Test Lakehouse',
        description: 'Test description',
        type: 'Lakehouse' as const,
        workspaceId: 'test-workspace-id',
      };

      // Mock the request method to return immediate response (201)
      vi.spyOn(lakehouseManager as any, 'request').mockResolvedValue(
        mockLakehouse
      );

      const result = await lakehouseManager.createLakehouse(
        'test-workspace-id',
        'Test Lakehouse',
        'Test description'
      );

      expect(result).toEqual(mockLakehouse);
    });

    it('should handle async operation response (202)', async () => {
      const mockAsyncResponse = {
        isAsyncOperation: true,
        operationLocation:
          'https://api.fabric.microsoft.com/v1/operations/test-op-id',
        operationId: 'test-op-id',
        retryAfter: 30,
      };

      const mockLakehouse = {
        id: 'test-id',
        displayName: 'Test Lakehouse',
        description: 'Test description',
        type: 'Lakehouse' as const,
        workspaceId: 'test-workspace-id',
      };

      // Mock the request method to return 202 response first
      vi.spyOn(lakehouseManager as any, 'request').mockResolvedValue(
        mockAsyncResponse
      );

      // Mock the handleAsyncOperation method
      vi.spyOn(
        lakehouseManager as any,
        'handleAsyncOperation'
      ).mockResolvedValue(mockLakehouse);

      const result = await lakehouseManager.createLakehouse(
        'test-workspace-id',
        'Test Lakehouse',
        'Test description'
      );

      expect(result).toEqual(mockLakehouse);
    });

    it('should throw error for empty response', async () => {
      vi.spyOn(lakehouseManager as any, 'request').mockResolvedValue(null);

      await expect(
        lakehouseManager.createLakehouse('test-workspace-id', 'Test Lakehouse')
      ).rejects.toThrow('Failed to create lakehouse: Empty response received');
    });
  });

  describe('listLakehouses', () => {
    it('should return array of lakehouses', async () => {
      const mockLakehouses = [
        {
          id: 'test-id-1',
          displayName: 'Lakehouse 1',
          type: 'Lakehouse' as const,
          workspaceId: 'test-workspace-id',
        },
        {
          id: 'test-id-2',
          displayName: 'Lakehouse 2',
          type: 'Lakehouse' as const,
          workspaceId: 'test-workspace-id',
        },
      ];

      vi.spyOn(lakehouseManager as any, 'request').mockResolvedValue({
        value: mockLakehouses,
      });

      const result = await lakehouseManager.listLakehouses('test-workspace-id');

      expect(result).toEqual(mockLakehouses);
    });

    it('should return empty array for no lakehouses', async () => {
      vi.spyOn(lakehouseManager as any, 'request').mockResolvedValue({
        value: [],
      });

      const result = await lakehouseManager.listLakehouses('test-workspace-id');

      expect(result).toEqual([]);
    });
  });

  describe('getOrCreateLakehouse', () => {
    it('should return existing lakehouse if found', async () => {
      const existingLakehouse = {
        id: 'existing-id',
        displayName: 'Existing Lakehouse',
        type: 'Lakehouse' as const,
        workspaceId: 'test-workspace-id',
      };

      vi.spyOn(lakehouseManager, 'listLakehouses').mockResolvedValue([
        existingLakehouse,
      ]);

      const result = await lakehouseManager.getOrCreateLakehouse({
        workspaceId: 'test-workspace-id',
        displayName: 'Existing Lakehouse',
        description: 'Test description',
      });

      expect(result).toEqual(existingLakehouse);
    });

    it('should create new lakehouse if none exists', async () => {
      const newLakehouse = {
        id: 'new-id',
        displayName: 'New Lakehouse',
        type: 'Lakehouse' as const,
        workspaceId: 'test-workspace-id',
      };

      vi.spyOn(lakehouseManager, 'listLakehouses').mockResolvedValue([]);
      vi.spyOn(lakehouseManager, 'createLakehouse').mockResolvedValue(
        newLakehouse
      );

      const result = await lakehouseManager.getOrCreateLakehouse({
        workspaceId: 'test-workspace-id',
        displayName: 'New Lakehouse',
        description: 'Test description',
      });

      expect(result).toEqual(newLakehouse);
    });
  });
});
