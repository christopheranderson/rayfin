/**
 * Result of a single setup check (prerequisite, auth, etc.).
 */
export interface CheckResult {
  readonly status: 'pass' | 'fail' | 'warn';
  readonly name: string;
  /** Human-readable detail, e.g. "v20.11.0" or "Not found". */
  readonly detail: string;
  /** URL for the user to install/upgrade the tool. */
  readonly installUrl?: string;
}

/**
 * Definition of a prerequisite tool to check.
 */
export interface PrereqDefinition {
  readonly name: string;
  /** Shell command to run, e.g. "node --version". */
  readonly command: string;
  readonly installUrl: string;
  /** Minimum required major version (e.g. 20 for Node.js). */
  readonly minMajorVersion?: number;
  /** Optional note shown to the user. */
  readonly note?: string;
}

/**
 * Output from running a shell command.
 */
export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunOptions {
  readonly signal?: AbortSignal;
}

/**
 * Abstraction for running a shell command.
 * Consumers inject platform-specific implementations (child_process, etc.).
 */
export interface CommandRunner {
  run(command: string, options?: CommandRunOptions): Promise<CommandOutput>;
}
