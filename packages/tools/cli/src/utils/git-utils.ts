import { execSync } from 'child_process';

export interface GitInfo {
  branch: string;
  isGitRepo: boolean;
  originalBranch?: string;
}

/**
 * Get current git branch information
 */
export async function getCurrentGitInfo(): Promise<GitInfo> {
  try {
    // Check if we're in a git repository
    execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: 'ignore' });

    // Get current branch name
    const branchOutput = execSync('git branch --show-current', {
      encoding: 'utf8',
    });
    const fullBranch = branchOutput.trim();

    if (!fullBranch) {
      throw new Error('Unable to determine current git branch');
    }

    // Extract last segment after splitting on '/'
    const branchSegments = fullBranch.split('/');
    const branch = branchSegments[branchSegments.length - 1];

    return {
      branch: normalizeBranchName(branch),
      isGitRepo: true,
      originalBranch: fullBranch,
    };
  } catch (error) {
    return {
      branch: 'default',
      isGitRepo: false,
    };
  }
}

/**
 * Normalize git branch name for Azure resource naming
 */
export function normalizeBranchName(branchName: string): string {
  return branchName.toLowerCase().replace(/[^a-z0-9-]/g, '');
}
