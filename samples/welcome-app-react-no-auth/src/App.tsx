import { RayfinClient } from '@microsoft/rayfin-client';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppSchema } from '../rayfin/data/schema';

const DATE_FORMATTER = new Intl.DateTimeFormat(
  [globalThis.navigator?.language, 'en-US'].filter((locale): locale is string =>
    Boolean(locale?.trim())
  ),
  {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }
);

type TimestampRecord = AppSchema['Timestamp'];

function formatDate(value?: Date) {
  if (!value) {
    return '—';
  }

  return DATE_FORMATTER.format(value);
}

export default function App() {
  const [timestamps, setTimestamps] = useState<TimestampRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  const rayfinClient = useMemo(() => {
    const baseUrl =
      (import.meta.env.VITE_RAYFIN_API_URL as string | undefined) ||
      'http://localhost:5168';

    if (!import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY) {
      console.error(
        'VITE_RAYFIN_PUBLISHABLE_KEY is not set in the environment variables. Please use the .env file to set it locally.'
      );
    }

    // Get optional project ID from environment variables (set by rayfin up)
    const projectId = import.meta.env.VITE_FABRIC_ITEM_ID as string | undefined;

    const headers: Record<string, string> = {};

    // include managed hosting moniker if projectId is provided (set by rayfin up)
    if (projectId) {
      headers['x-ms-workload-resource-moniker'] = projectId;
    }

    return new RayfinClient<AppSchema>({
      baseUrl,
      publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
      authStorage: false,
      headers,
    });
  }, []);

  const refreshTimestamps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await rayfinClient.data.Timestamp.select([
        'id',
        'timestamp',
      ])
        .orderBy({ timestamp: 'desc' })
        .first(100)
        .execute();

      setTimestamps(items);
      setLastRefresh(Date.now());
      setStatus('Timestamps refreshed successfully.');
    } catch (err) {
      console.error('Failed to load timestamps', err);
      setError('Unable to load timestamps. Ensure rayfin up is running.');
    } finally {
      setLoading(false);
    }
  }, [rayfinClient]);

  const sendTimestamp = useCallback(async () => {
    setCreating(true);
    setError(null);
    setStatus(null);
    try {
      const now = new Date();

      await rayfinClient.data.Timestamp.create({
        timestamp: now,
      });
      setStatus('Timestamp saved successfully.');
    } catch (err) {
      console.error('Failed to send timestamp', err);
      setError('Unable to send timestamp.');
    } finally {
      setCreating(false);
    }
  }, [rayfinClient]);

  useEffect(() => {
    refreshTimestamps();
  }, [refreshTimestamps]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeout = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(timeout);
  }, [status]);

  const lastRefreshLabel = lastRefresh
    ? DATE_FORMATTER.format(new Date(lastRefresh))
    : 'Never';

  return (
    <section className="timestamp-card">
      <header className="timestamp-header">
        <div>
          <p className="timestamp-eyebrow">Live Rayfin data</p>
          <h3 className="timestamp-title">Timestamp Tracker</h3>
          <p className="timestamp-subtitle">
            Click "Send Timestamp" to push the current time into your Rayfin
            backend, then refresh to read it back. Everything below talks to the
            Data API directly.
          </p>
        </div>
        <div className="timestamp-meta">
          <span className="timestamp-label">Last refresh:</span>
          <span className="timestamp-value">{lastRefreshLabel}</span>
        </div>
      </header>

      <div className="timestamp-actions">
        <button
          type="button"
          className="timestamp-button primary"
          onClick={sendTimestamp}
          disabled={creating}
        >
          {creating ? 'Sending…' : 'Send Timestamp'}
        </button>
        <button
          type="button"
          className="timestamp-button ghost"
          onClick={refreshTimestamps}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>

      {(error || status) && (
        <div className="timestamp-messages">
          {error && <p className="timestamp-error">{error}</p>}
          {status && <p className="timestamp-success">{status}</p>}
        </div>
      )}

      <div className="timestamp-table-wrapper">
        {timestamps.length === 0 && !loading ? (
          <p className="timestamp-empty">
            No timestamps yet. Click "Send Timestamp" to create one.
          </p>
        ) : (
          <table className="timestamp-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {timestamps.map((entry) => (
                <tr key={entry.id}>
                  <td className="timestamp-mono">{entry.id}</td>
                  <td>{formatDate(entry.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
