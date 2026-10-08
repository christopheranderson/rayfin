import type { DiagnosticEvent } from '@microsoft/rayfin-tools-common/_internal/adapters';

export type DiagnosticLevel = 'DEBUG' | 'ERROR' | 'INFO';

/** Format one diagnostic event as one UTF-8 log line. */
export function formatDiagnosticRecord(
  timestamp: Date,
  level: DiagnosticLevel,
  event: DiagnosticEvent
): string {
  const area = event.area.replace(/\s+/g, '.');
  const message = event.message.replace(/[\r\n]+/g, '\\n');
  const data = event.data ? ` ${JSON.stringify(event.data)}` : '';
  return `${timestamp.toISOString()} ${level} ${area} ${message}${data}\n`;
}
