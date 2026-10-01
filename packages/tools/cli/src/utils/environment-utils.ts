import { getCurrentUser, normalizeUsername } from '../auth/user-utils.js';

import { getCurrentGitInfo } from './git-utils.js';

export interface EnvironmentInfo {
  environment: string;
  source: 'custom' | 'user-git' | 'fallback';
  details: {
    username?: string;
    branch?: string;
    customValue?: string;
  };
}

/**
 * Validate environment name for Azure resource naming
 */
export function validateEnvironmentName(env: string): void {
  const errors = [];

  if (env.length > 50)
    errors.push('Environment name too long (max 50 characters)');
  if (!/^[a-z0-9-]+$/.test(env))
    errors.push(
      'Environment name must contain only lowercase letters, numbers, and hyphens'
    );
  if (env.startsWith('-') || env.endsWith('-'))
    errors.push('Environment name cannot start or end with a hyphen');

  const sensitivePattern = /password|secret|key|token|pwd/i;
  if (sensitivePattern.test(env)) {
    const match = env.toLowerCase().match(sensitivePattern)?.[0];
    errors.push(
      `Environment name should not contain sensitive terms like '${match}'`
    );
  }

  if (errors.length > 0) throw new Error(errors[0]);
}

/**
 * Resolve environment name from custom value or user/git context
 */
export async function resolveEnvironment(
  customEnvironment?: string
): Promise<EnvironmentInfo> {
  if (customEnvironment) {
    // Sanitize and validate custom environment
    const sanitized = customEnvironment
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    validateEnvironmentName(sanitized);

    return {
      environment: sanitized,
      source: 'custom',
      details: { customValue: customEnvironment },
    };
  }

  try {
    // Get user info from auth state
    const userInfo = await getCurrentUser();
    const username = normalizeUsername(userInfo.username);

    // Get git branch info
    const gitInfo = await getCurrentGitInfo();
    const branch = gitInfo.branch;

    const environment = `${username}-${branch}`;

    // Validate generated environment name
    validateEnvironmentName(environment);

    return {
      environment,
      source: 'user-git',
      details: { username, branch },
    };
  } catch (error) {
    throw new Error(
      `Failed to resolve environment: ${(error as Error).message}\n` +
        `Please provide an environment or ensure you are logged in with 'rayfin login'.`
    );
  }
}

/**
 * Check if environment appears to be production
 */
export function isProductionEnvironment(environment: string): boolean {
  const prodPatterns = ['prod', 'production', 'live', 'master', 'main'];
  const envLower = environment.toLowerCase();
  return prodPatterns.some((pattern) => envLower.includes(pattern));
}
