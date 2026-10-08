/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-export all project types from the canonical source in @microsoft/rayfin-tools-common.
// This file exists only for backwards-compatible imports; prefer importing from
// '@microsoft/rayfin-tools-common' directly.
export type {
  Dialect,
  FabricConfig,
  MagicLinkConfig,
  PasswordConfig,
  PasswordlessConfig,
  RayfinConfig,
  SmsOtpConfig,
  StaticHostingConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
