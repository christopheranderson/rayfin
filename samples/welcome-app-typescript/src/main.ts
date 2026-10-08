import { RayfinClient } from '@microsoft/rayfin-client';

import type { AppSchema } from '../rayfin/data/schema';
import './style.css';

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

type TimestampRecord = AppSchema['Timestamp'];

function formatDate(value?: Date): string {
  if (!value) {
    return '—';
  }
  return DATE_FORMATTER.format(value);
}

class TimestampApp {
  private timestamps: TimestampRecord[] = [];
  private loading = false;
  private error: string | null = null;
  private status: string | null = null;
  private lastRefresh: number | null = null;
  private rayfinClient: RayfinClient<AppSchema>;
  private statusTimeoutId: number | null = null;

  constructor() {
    const baseUrl =
      (import.meta.env.VITE_RAYFIN_API_URL as string | undefined) ||
      'http://localhost:5168';

    if (!import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY) {
      console.error(
        'VITE_RAYFIN_PUBLISHABLE_KEY is not set in the environment variables.'
      );
    }

    const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

    // Get optional project ID from environment variables (set by rayfin up)
    const projectId = import.meta.env.VITE_FABRIC_ITEM_ID as string | undefined;

    const headers: Record<string, string> = {};

    // include managed hosting moniker if projectId is provided (set by rayfin up)
    if (projectId) {
      headers['x-ms-workload-resource-moniker'] = projectId;
    }

    this.rayfinClient = new RayfinClient<AppSchema>({
      baseUrl,
      publishableKey,
      authStorage: false,
      headers,
    });

    this.init();
  }

  private init(): void {
    this.render();
    this.attachEventListeners();
    this.refreshTimestamps();
  }

  private render(): void {
    const rootElement = document.getElementById('timestamp-root');
    if (!rootElement) {
      console.error('Timestamp root element not found.');
      return;
    }

    rootElement.innerHTML = `
      <section class="timestamp-card">
        <header class="timestamp-header">
          <div>
            <p class="timestamp-eyebrow">Live Rayfin data</p>
            <h3 class="timestamp-title">Timestamp Tracker</h3>
            <p class="timestamp-subtitle">
              Click "Send Timestamp" to push the current time into your Rayfin
              backend, then refresh to read it back. Everything below talks to the
              Data API directly.
            </p>
          </div>
          <div class="timestamp-meta">
            <span class="timestamp-label">Last refresh:</span>
            <span class="timestamp-value" id="last-refresh">Never</span>
          </div>
        </header>

        <div class="timestamp-actions">
          <button
            type="button"
            class="timestamp-button primary"
            id="send-timestamp-btn"
          >
            Send Timestamp
          </button>
          <button
            type="button"
            class="timestamp-button ghost"
            id="refresh-btn"
          >
            Refresh list
          </button>
        </div>

        <div class="timestamp-messages" id="messages" style="display: none;"></div>

        <div class="timestamp-table-wrapper" id="table-wrapper">
          <p class="timestamp-empty">
            No timestamps yet. Click "Send Timestamp" to create one.
          </p>
        </div>
      </section>
    `;
  }

  private attachEventListeners(): void {
    const sendBtn = document.getElementById('send-timestamp-btn');
    const refreshBtn = document.getElementById('refresh-btn');

    sendBtn?.addEventListener('click', () => this.sendTimestamp());
    refreshBtn?.addEventListener('click', () => this.handleManualRefresh());
  }

  private async refreshTimestamps(): Promise<void> {
    this.setLoading(true);
    this.clearError();

    try {
      const items = await this.rayfinClient.data.Timestamp.select([
        'id',
        'timestamp',
      ])
        .orderBy({ timestamp: 'desc' })
        .first(100)
        .execute();

      this.timestamps = items;
      this.lastRefresh = Date.now();
      this.setStatus('Timestamps refreshed successfully.');
      this.updateUI();
    } catch (err) {
      console.error('Failed to load timestamps', err);
      this.setError('Unable to load timestamps. Ensure rayfin up is running.');
    } finally {
      this.setLoading(false);
    }
  }

  private async sendTimestamp(): Promise<void> {
    this.setCreating(true);
    this.clearError();
    this.clearStatus();

    try {
      const now = new Date();
      await this.rayfinClient.data.Timestamp.create({
        timestamp: now,
      });
      this.setStatus('Timestamp saved successfully.');
      // await this.refreshTimestamps();
    } catch (err) {
      console.error('Failed to send timestamp', err);
      this.setError('Unable to send timestamp.');
    } finally {
      this.setCreating(false);
    }
  }

  private handleManualRefresh(): void {
    this.refreshTimestamps();
  }

  private updateUI(): void {
    this.updateLastRefresh();
    this.updateTable();
  }

  private updateLastRefresh(): void {
    const lastRefreshEl = document.getElementById('last-refresh');
    if (lastRefreshEl) {
      lastRefreshEl.textContent = this.lastRefresh
        ? DATE_FORMATTER.format(new Date(this.lastRefresh))
        : 'Never';
    }
  }

  private updateTable(): void {
    const wrapper = document.getElementById('table-wrapper');
    if (!wrapper) return;

    if (this.timestamps.length === 0 && !this.loading) {
      wrapper.innerHTML = `
        <p class="timestamp-empty">
          No timestamps yet. Click "Send Timestamp" to create one.
        </p>
      `;
    } else {
      const rows = this.timestamps
        .map(
          (entry) => `
          <tr>
            <td class="timestamp-mono">${entry.id}</td>
            <td>${formatDate(entry.timestamp)}</td>
          </tr>
        `
        )
        .join('');

      wrapper.innerHTML = `
        <table class="timestamp-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `;
    }
  }

  private setLoading(value: boolean): void {
    this.loading = value;
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      if (value) {
        refreshBtn.setAttribute('disabled', 'true');
      } else {
        refreshBtn.removeAttribute('disabled');
      }
      refreshBtn.textContent = value ? 'Refreshing…' : 'Refresh list';
    }
  }

  private setCreating(value: boolean): void {
    const sendBtn = document.getElementById('send-timestamp-btn');
    if (sendBtn) {
      if (value) {
        sendBtn.setAttribute('disabled', 'true');
      } else {
        sendBtn.removeAttribute('disabled');
      }
      sendBtn.textContent = value ? 'Sending…' : 'Send Timestamp';
    }
  }

  private setError(message: string): void {
    this.error = message;
    this.updateMessages();
  }

  private clearError(): void {
    this.error = null;
    this.updateMessages();
  }

  private setStatus(message: string): void {
    this.status = message;
    this.updateMessages();

    // Clear status after 2.5 seconds
    if (this.statusTimeoutId !== null) {
      clearTimeout(this.statusTimeoutId);
    }
    this.statusTimeoutId = window.setTimeout(() => {
      this.clearStatus();
    }, 2500);
  }

  private clearStatus(): void {
    this.status = null;
    this.updateMessages();
  }

  private updateMessages(): void {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

    if (!this.error && !this.status) {
      messagesEl.style.display = 'none';
      messagesEl.innerHTML = '';
      return;
    }

    messagesEl.style.display = 'block';
    let html = '';
    if (this.error) {
      html += `<p class="timestamp-error">${this.error}</p>`;
    }
    if (this.status) {
      html += `<p class="timestamp-success">${this.status}</p>`;
    }
    messagesEl.innerHTML = html;
  }
}

// Initialize the app when DOM is ready
const rootElement = document.getElementById('timestamp-root');
if (rootElement) {
  new TimestampApp();
} else {
  console.error('Timestamp root element not found.');
}
