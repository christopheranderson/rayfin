import { AudienceType } from './connection.js';

/**
 * Audience scopes for audience types not yet supported natively by the host extension.
 * Once the host adds built-in support for an audience, remove it from this map.
 * Retained scope overrides do not imply membership in the public AudienceType enum.
 */
export const AUDIENCE_SCOPE_OVERRIDES: Partial<
  Record<AudienceType | 'Kusto' | 'WorkIQ', string>
> = {
  [AudienceType.AzureAI]: 'https://ai.azure.com/user_impersonation',
  [AudienceType.ADO]: '499b84ac-1321-427f-aa17-267ca6975798/.default',
  Kusto: 'https://kusto.kusto.windows.net/user_impersonation',
  WorkIQ: 'https://workiq.svc.cloud.microsoft/mcp/.default',
};
