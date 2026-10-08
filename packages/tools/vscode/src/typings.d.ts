/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal ambient `process` declaration for the desktop extension host.
 * The full `@types/node` package is intentionally excluded from this project
 * because the extension also targets the web host where Node globals are
 * unavailable. Only the subset actually used at runtime is declared here.
 */
declare const process:
  | {
      env: Record<string, string | undefined>;
    }
  | undefined;
