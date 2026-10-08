/**
 * Escape a value for safe display in shell commands (cross-platform).
 * Defaults to the current platform when available, falls back to POSIX quoting.
 */
export function shellEscape(value: string, platform?: string): string {
  const p =
    platform ?? (typeof process !== 'undefined' ? process.platform : undefined);
  if (p === 'win32') {
    // PowerShell: single quotes prevent variable interpolation
    return "'" + value.replace(/'/g, "''") + "'";
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
