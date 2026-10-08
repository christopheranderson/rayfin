import type {
  Diagnostics,
  Logger,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import {
  silentDiagnostics,
  silentLogger,
} from '@microsoft/rayfin-tools-common/_internal/adapters';
import type { Command } from 'commander';

import {
  emitJson,
  modeError,
  modeLog,
  modeWarn,
  resolveCommandFlags,
} from '../utils/output-mode.js';

/** Host rendering profile, resolved once at the command boundary. @internal */
export interface CommandOutput {
  json: boolean;
  logger: Logger;
  diagnostics: Diagnostics;
  writeJson(value: Record<string, unknown>): void;
}

/** Reuse canonical flag resolution and route output through host adapters. @internal */
export function createCommandOutput(command: Command): CommandOutput {
  const { mode, verbose } = resolveCommandFlags(command);
  return {
    json: mode === 'json',
    logger:
      mode === 'json'
        ? silentLogger
        : {
            log: (message) => modeLog(mode, message),
            warn: (message) => modeWarn(mode, message),
            error: (message) => modeError(mode, message),
          },
    diagnostics: verbose
      ? {
          debug: (event) =>
            modeLog(
              'plain',
              `[${event.area}] ${event.message}${event.data ? ` ${JSON.stringify(event.data)}` : ''}`
            ),
        }
      : silentDiagnostics,
    writeJson: emitJson,
  };
}
