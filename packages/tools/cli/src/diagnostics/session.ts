import { randomUUID } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DiagnosticEvent,
  Diagnostics,
} from '@microsoft/rayfin-tools-common/_internal/adapters';

import { RAYFIN_CONFIG_DIR } from '../auth/constants.js';

import { formatDiagnosticRecord, type DiagnosticLevel } from './format.js';
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  type DiagnosticRetentionLimits,
  pruneDiagnosticLogs,
} from './retention.js';
import {
  type DiagnosticSanitizerOptions,
  sanitizeDiagnosticEvent,
} from './sanitize.js';

const FINAL_RECORD_RESERVE_BYTES = 4_096;

export interface DiagnosticOutcome {
  status: 'cancelled' | 'failed' | 'success';
  exitCode?: number;
  error?: unknown;
}

export interface DiagnosticSession {
  readonly diagnostics: Diagnostics;
  readonly logPath?: string;
  close(outcome: DiagnosticOutcome): Promise<void>;
}

export interface CreateDiagnosticSessionOptions {
  commandName: string;
  cliVersion: string;
  safeParameterNames?: string[];
  configDir?: string;
  projectRoot?: string;
  mirror?: (line: string) => void;
  now?: () => Date;
  invocationId?: string;
  limits?: Partial<DiagnosticRetentionLimits>;
}

/** Create one best-effort persistent diagnostic session for a CLI invocation. */
export async function createCliDiagnosticSession(
  options: CreateDiagnosticSessionOptions
): Promise<DiagnosticSession> {
  const now = options.now ?? (() => new Date());
  const invocationId = normalizeInvocationId(options.invocationId);
  const limits = { ...DEFAULT_DIAGNOSTIC_LIMITS, ...options.limits };
  const sanitizerOptions = {
    projectRoot: options.projectRoot,
    homeDir: homedir(),
  } satisfies DiagnosticSanitizerOptions;
  const commandSlug = toCommandSlug(options.commandName);
  const logDir = join(options.configDir ?? RAYFIN_CONFIG_DIR, 'logs');
  const filename = `${toFileTimestamp(now())}-${commandSlug}-${invocationId}.log`;
  const logPath = join(logDir, filename);
  const startEvent: DiagnosticEvent = {
    area: 'invocation',
    message: 'Command started',
    data: {
      schemaVersion: 1,
      invocationId,
      commandName: options.commandName,
      cliVersion: options.cliVersion,
      safeParameterNames: options.safeParameterNames ?? [],
      processId: process.pid,
    },
  };

  let handle: FileHandle | undefined;
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    try {
      await pruneDiagnosticLogs(logDir, limits, now().getTime());
    } catch {
      // A retention failure must not prevent the current diagnostic session.
    }
    handle = await open(logPath, 'wx', 0o600);
  } catch {
    return createFallbackSession(
      options.mirror,
      now,
      sanitizerOptions,
      startEvent
    );
  }

  try {
    return new FileDiagnosticSession({
      handle,
      logPath,
      now,
      mirror: options.mirror,
      sanitizerOptions,
      maxFileBytes: limits.maxFileBytes,
      startEvent,
    });
  } catch {
    try {
      await handle.close();
    } catch {
      // Session creation remains best-effort even when cleanup also fails.
    }
    return createFallbackSession(
      options.mirror,
      now,
      sanitizerOptions,
      startEvent
    );
  }
}

interface FileDiagnosticSessionOptions {
  handle: FileHandle;
  logPath: string;
  now: () => Date;
  mirror?: (line: string) => void;
  sanitizerOptions: DiagnosticSanitizerOptions;
  maxFileBytes: number;
  startEvent: DiagnosticEvent;
}

class FileDiagnosticSession implements DiagnosticSession {
  readonly diagnostics: Diagnostics;
  readonly logPath: string;

  private pending = Promise.resolve();
  private bytesWritten = 0;
  private fileEnabled = true;
  private truncated = false;
  private closed = false;
  private readonly startedAt: number;

  constructor(private readonly options: FileDiagnosticSessionOptions) {
    this.logPath = options.logPath;
    this.startedAt = options.now().getTime();
    this.diagnostics = {
      debug: (event) => {
        if (this.closed) return;
        try {
          this.emit('DEBUG', event);
        } catch {
          // Invalid diagnostic data must never affect the requested command.
        }
      },
    };
    this.emit('INFO', options.startEvent);
  }

  async close(outcome: DiagnosticOutcome): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.emit(
        outcome.status === 'failed' ? 'ERROR' : 'INFO',
        {
          area: 'invocation',
          message: 'Command completed',
          data: {
            status: outcome.status,
            exitCode: outcome.exitCode,
            durationMs: this.options.now().getTime() - this.startedAt,
            truncated: this.truncated,
            error: outcome.error,
          },
        },
        true
      );
    } catch {
      try {
        this.emit(
          outcome.status === 'failed' ? 'ERROR' : 'INFO',
          {
            area: 'invocation',
            message: 'Command completed',
            data: {
              status: outcome.status,
              exitCode: outcome.exitCode,
              truncated: this.truncated,
              error: '[UNAVAILABLE]',
            },
          },
          true
        );
      } catch {
        // A malformed outcome must not prevent queued writes from flushing.
      }
    }
    await this.pending;
    try {
      await this.options.handle.close();
    } catch {
      // Closing diagnostics is best-effort and cannot change command outcome.
    }
  }

  private emit(
    level: DiagnosticLevel,
    event: DiagnosticEvent,
    final = false
  ): void {
    const sanitized = sanitizeDiagnosticEvent(
      event,
      this.options.sanitizerOptions
    );
    const line = formatDiagnosticRecord(this.options.now(), level, sanitized);
    try {
      this.options.mirror?.(line);
    } catch {
      // A terminal mirror failure must not affect persistence or the command.
    }
    this.enqueueWrite(line, final);
  }

  private enqueueWrite(line: string, final: boolean): void {
    if (!this.fileEnabled) {
      return;
    }
    const finalReserve = Math.min(
      FINAL_RECORD_RESERVE_BYTES,
      Math.floor(this.options.maxFileBytes / 3)
    );
    const marker = formatDiagnosticRecord(this.options.now(), 'INFO', {
      area: 'diagnostics',
      message: 'Additional diagnostic records were truncated',
    });
    const markerBytes = Buffer.byteLength(marker);
    const regularLimit = this.options.maxFileBytes - finalReserve - markerBytes;
    const lineBytes = Buffer.byteLength(line);
    if (!final && this.bytesWritten + lineBytes > regularLimit) {
      if (!this.truncated) {
        this.truncated = true;
        this.queueRawWrite(marker, this.options.maxFileBytes - finalReserve);
      }
      return;
    }
    this.queueRawWrite(line, this.options.maxFileBytes);
  }

  private queueRawWrite(line: string, limit: number): void {
    const available = limit - this.bytesWritten;
    if (available <= 0) {
      return;
    }
    const bounded = truncateRecord(Buffer.from(line), available);
    this.bytesWritten += bounded.byteLength;
    this.pending = this.pending
      .then(async () => {
        if (this.fileEnabled) {
          await this.options.handle.write(bounded);
        }
      })
      .catch(() => {
        this.fileEnabled = false;
      });
  }
}

function createFallbackSession(
  mirror: ((line: string) => void) | undefined,
  now: () => Date,
  sanitizerOptions: DiagnosticSanitizerOptions,
  startEvent: DiagnosticEvent
): DiagnosticSession {
  const startedAt = now().getTime();
  let closed = false;
  const emit = (level: DiagnosticLevel, event: DiagnosticEvent): void => {
    const line = formatDiagnosticRecord(
      now(),
      level,
      sanitizeDiagnosticEvent(event, sanitizerOptions)
    );
    try {
      mirror?.(line);
    } catch {
      // A terminal mirror failure must not affect the requested command.
    }
  };

  try {
    emit('INFO', startEvent);
  } catch {
    // Diagnostics remain best-effort when persistence cannot start.
  }

  return {
    diagnostics: {
      debug(event) {
        if (closed) return;
        try {
          emit('DEBUG', event);
        } catch {
          // Diagnostics remain best-effort when both persistence and mirror fail.
        }
      },
    },
    async close(outcome) {
      if (closed) return;
      closed = true;
      const level = outcome.status === 'failed' ? 'ERROR' : 'INFO';
      try {
        emit(level, {
          area: 'invocation',
          message: 'Command completed',
          data: {
            status: outcome.status,
            exitCode: outcome.exitCode,
            durationMs: now().getTime() - startedAt,
            truncated: false,
            error: outcome.error,
          },
        });
      } catch {
        try {
          emit(level, {
            area: 'invocation',
            message: 'Command completed',
            data: {
              status: outcome.status,
              exitCode: outcome.exitCode,
              truncated: false,
              error: '[UNAVAILABLE]',
            },
          });
        } catch {
          // A malformed outcome must not affect the requested command.
        }
      }
    },
  };
}

function toCommandSlug(commandName: string): string {
  return (
    commandName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'command'
  ).slice(0, 64);
}

function toFileTimestamp(date: Date): string {
  return date.toISOString().replace(/:(?=\d{2}(?::|\.))/g, '');
}

function normalizeInvocationId(invocationId?: string): string {
  return invocationId && /^[0-9a-f-]{36}$/i.test(invocationId)
    ? invocationId
    : randomUUID();
}

function truncateRecord(line: Buffer, available: number): Buffer {
  if (line.byteLength <= available) {
    return line;
  }
  const suffix = Buffer.from(' [TRUNCATED]\n');
  if (available <= suffix.byteLength) {
    return Buffer.alloc(0);
  }
  const prefix = truncateUtf8(line, available - suffix.byteLength);
  return Buffer.concat([prefix, suffix]);
}

function truncateUtf8(value: Buffer, maxBytes: number): Buffer {
  let end = Math.min(value.byteLength, maxBytes);
  while (end > 0 && (value[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return value.subarray(0, end);
}
