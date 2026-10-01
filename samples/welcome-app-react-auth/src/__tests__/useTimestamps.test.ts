import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Timestamp } from '../../rayfin/data/Timestamp';
import { useTimestamps } from '../hooks/useTimestamps';
import { ServiceContainer } from '../services/ServiceContainer';
import type { ITimestampService } from '../services/interfaces/ITimestampService';

// Create mock timestamp service
function createMockTimestampService(
  overrides: Partial<ITimestampService> = {}
): ITimestampService {
  return {
    getTimestamps: vi.fn().mockResolvedValue([]),
    addTimestamp: vi.fn().mockResolvedValue({
      id: 'ts-new',
      createdAt: new Date().toISOString(),
      user_id: 'user-1',
    }),
    ...overrides,
  };
}

describe('useTimestamps', () => {
  let mockTimestampService: ITimestampService;

  beforeEach(() => {
    mockTimestampService = createMockTimestampService();
    vi.spyOn(ServiceContainer, 'getInstance').mockReturnValue({
      authService: {} as never,
      timestampService: mockTimestampService,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches timestamps on mount', async () => {
    const existingTimestamps: Timestamp[] = [
      {
        id: 'ts-1',
        timestamp: new Date('2024-01-01T10:00:00Z'),
        createdAt: new Date('2024-01-01T10:00:00Z'),
        user_id: 'user-1',
      },
      {
        id: 'ts-2',
        timestamp: new Date('2024-01-01T11:00:00Z'),
        createdAt: new Date('2024-01-01T11:00:00Z'),
        user_id: 'user-1',
      },
    ];

    mockTimestampService.getTimestamps = vi
      .fn()
      .mockResolvedValue(existingTimestamps);

    const { result } = renderHook(() => useTimestamps());

    // Initially loading
    expect(result.current.loading).toBe(true);
    expect(result.current.timestamps).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.timestamps).toEqual(existingTimestamps);
    expect(result.current.error).toBeNull();
    expect(mockTimestampService.getTimestamps).toHaveBeenCalledTimes(1);
  });

  it('handles fetch error', async () => {
    mockTimestampService.getTimestamps = vi
      .fn()
      .mockRejectedValue(new Error('Network error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useTimestamps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.timestamps).toEqual([]);

    consoleSpy.mockRestore();
  });

  it('adds a new timestamp', async () => {
    const existingTimestamps: Timestamp[] = [
      {
        id: 'ts-1',
        timestamp: new Date('2024-01-01T10:00:00Z'),
        createdAt: new Date('2024-01-01T10:00:00Z'),
        user_id: 'user-1',
      },
    ];

    const newTimestamp: Timestamp = {
      id: 'ts-new',
      timestamp: new Date('2024-01-01T12:00:00Z'),
      createdAt: new Date('2024-01-01T12:00:00Z'),
      user_id: 'user-1',
    };

    mockTimestampService.getTimestamps = vi
      .fn()
      .mockResolvedValue(existingTimestamps);
    mockTimestampService.addTimestamp = vi.fn().mockResolvedValue(newTimestamp);

    const { result } = renderHook(() => useTimestamps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.timestamps).toHaveLength(1);

    await act(async () => {
      await result.current.addTimestamp();
    });

    // New timestamp should be at the beginning
    expect(result.current.timestamps).toHaveLength(2);
    expect(result.current.timestamps[0]).toEqual(newTimestamp);
    expect(mockTimestampService.addTimestamp).toHaveBeenCalledTimes(1);
  });

  it('handles add timestamp error', async () => {
    mockTimestampService.getTimestamps = vi.fn().mockResolvedValue([]);
    mockTimestampService.addTimestamp = vi
      .fn()
      .mockRejectedValue(new Error('Failed to save'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useTimestamps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // The hook re-throws the error, so we need to catch it
    let thrownError: Error | undefined;
    await act(async () => {
      try {
        await result.current.addTimestamp();
      } catch (e) {
        thrownError = e as Error;
      }
    });

    expect(thrownError?.message).toBe('Failed to save');
    expect(result.current.error).toBe('Failed to save');

    consoleSpy.mockRestore();
  });

  it('refreshes timestamps', async () => {
    const initialTimestamps: Timestamp[] = [
      {
        id: 'ts-1',
        timestamp: new Date('2024-01-01T10:00:00Z'),
        createdAt: new Date('2024-01-01T10:00:00Z'),
        user_id: 'user-1',
      },
    ];

    const updatedTimestamps: Timestamp[] = [
      {
        id: 'ts-1',
        timestamp: new Date('2024-01-01T10:00:00Z'),
        createdAt: new Date('2024-01-01T10:00:00Z'),
        user_id: 'user-1',
      },
      {
        id: 'ts-2',
        timestamp: new Date('2024-01-01T11:00:00Z'),
        createdAt: new Date('2024-01-01T11:00:00Z'),
        user_id: 'user-1',
      },
    ];

    mockTimestampService.getTimestamps = vi
      .fn()
      .mockResolvedValueOnce(initialTimestamps)
      .mockResolvedValueOnce(updatedTimestamps);

    const { result } = renderHook(() => useTimestamps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.timestamps).toHaveLength(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.timestamps).toHaveLength(2);
    expect(mockTimestampService.getTimestamps).toHaveBeenCalledTimes(2);
  });

  it('clears error on successful fetch after error', async () => {
    mockTimestampService.getTimestamps = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce([]);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useTimestamps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();

    consoleSpy.mockRestore();
  });
});
