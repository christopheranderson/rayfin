import { useCallback, useEffect, useState } from 'react';

import type { Timestamp } from '../../rayfin/data/Timestamp';
import { ServiceContainer } from '../services/ServiceContainer';

interface UseTimestampsResult {
  timestamps: Timestamp[];
  loading: boolean;
  error: string | null;
  addTimestamp: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useTimestamps(): UseTimestampsResult {
  const [timestamps, setTimestamps] = useState<Timestamp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const timestampService = ServiceContainer.getInstance().timestampService;

  const fetchTimestamps = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await timestampService.getTimestamps();
      setTimestamps(data);
    } catch (err) {
      console.error('Failed to fetch timestamps:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to fetch timestamps'
      );
    } finally {
      setLoading(false);
    }
  }, [timestampService]);

  const addTimestamp = useCallback(async () => {
    setError(null);

    try {
      const newTimestamp = await timestampService.addTimestamp();
      // Add to the beginning of the list (most recent first)
      setTimestamps((prev) => [newTimestamp, ...prev]);
    } catch (err) {
      console.error('Failed to add timestamp:', err);
      setError(err instanceof Error ? err.message : 'Failed to add timestamp');
      throw err;
    }
  }, [timestampService]);

  // Fetch timestamps on mount
  useEffect(() => {
    fetchTimestamps();
  }, [fetchTimestamps]);

  return {
    timestamps,
    loading,
    error,
    addTimestamp,
    refresh: fetchTimestamps,
  };
}
