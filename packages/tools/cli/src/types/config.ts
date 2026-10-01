// Re-export all project types from the canonical source in @microsoft/rayfin-tools-common.
// This file exists only for backwards-compatible imports; prefer importing from
// '@microsoft/rayfin-tools-common' directly.
export type {
  AuthMethod,
  Dialect,
  FabricConfig,
  FunctionsConfig,
  MagicLinkConfig,
  PasswordConfig,
  PasswordlessConfig,
  RayfinConfig,
  SmsOtpConfig,
  StaticHostingConfig,
} from '@microsoft/rayfin-tools-common/_internal/config';
